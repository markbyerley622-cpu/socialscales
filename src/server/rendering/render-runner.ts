import { mkdtemp, rename, rm, stat, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { prisma } from "@/server/db";
import {
  ActorType,
  AssetKind,
  AssetOrigin,
  AssetStatus,
  RenderStage,
  RenderStatus,
} from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { absolutePath, STORAGE_ROOT } from "@/server/storage";
import { activityActions, recordActivity } from "@/server/activity/log";
import { ffmpegProvider } from "./ffmpeg-provider";
import { validateEdl } from "./edl";
import {
  RenderError,
  edlDurationSeconds,
  isRetryableRenderError,
  type EditingProvider,
  type MediaProbe,
  type RenderEdl,
  type RenderErrorKind,
  type RenderSource,
} from "./types";

/**
 * The render runner.
 *
 * Owns the lifecycle that the editing provider deliberately does not: the job
 * record, idempotency, retries, the deterministic output location and the
 * verification of what was actually produced.
 *
 * Three properties are load-bearing:
 *
 *  - **The output location is derived, not assigned.** It is a function of the
 *    idempotency key, so a retry after a crash writes to the same place and a
 *    half-finished file is overwritten rather than accumulating.
 *  - **The file moves into storage only after it has been probed.** A render
 *    that produced an unplayable file must not leave one behind that looks
 *    finished.
 *  - **The asset row is written last.** A crash between the file landing and the
 *    row existing leaves a findable file at a known key, which the next attempt
 *    reuses.
 */

export type RunRenderResult = {
  renderJobId: string;
  outcome: "succeeded" | "failed" | "cancelled" | "skipped";
  outputAssetId?: string;
  outputKey?: string;
  errorKind?: RenderErrorKind;
  error?: string;
  retryable?: boolean;
  durationMs?: number;
};

/** Deterministic: the same request always writes to the same key. */
export function renderOutputKey(projectId: string, idempotencyKey: string): string {
  return `renders/${projectId}/${idempotencyKey}.mp4`;
}

export async function runRenderJob(
  renderJobId: string,
  options: { provider?: EditingProvider; signal?: AbortSignal } = {},
): Promise<RunRenderResult> {
  const provider = options.provider ?? ffmpegProvider;

  const job = await prisma.renderJob.findUnique({
    where: { id: renderJobId },
    include: { variant: { select: { id: true, assetId: true, label: true } } },
  });
  if (!job) {
    return {
      renderJobId,
      outcome: "failed",
      errorKind: "UNKNOWN",
      error: "The render job no longer exists.",
      retryable: false,
    };
  }

  if (job.status === RenderStatus.CANCELLED) {
    return { renderJobId, outcome: "cancelled" };
  }

  // Already done. A duplicate delivery, or a retry of a job that finished after
  // the worker lost its lock — either way, do not render it twice.
  if (job.status === RenderStatus.SUCCEEDED && job.outputAssetId) {
    return {
      renderJobId,
      outcome: "skipped",
      outputAssetId: job.outputAssetId,
      ...(job.outputKey ? { outputKey: job.outputKey } : {}),
    };
  }

  const startedAt = new Date();
  await prisma.renderJob.update({
    where: { id: job.id },
    data: {
      status: RenderStatus.RUNNING,
      stage: RenderStage.VALIDATING,
      attempts: { increment: 1 },
      progress: 0,
      startedAt,
      failureStage: null,
      errorKind: null,
      error: null,
      provider: provider.name,
    },
  });

  const edl = job.config as unknown as RenderEdl;
  let workDir: string | null = null;

  try {
    const availability = await provider.availability();
    if (!availability.available) {
      throw new RenderError(
        "FFMPEG_UNAVAILABLE",
        RenderStage.VALIDATING,
        availability.reason,
      );
    }

    const sources = await resolveSources(job.sourceAssetIds);
    await validateEdl(edl, sources);
    throwIfCancelled(options.signal, RenderStage.VALIDATING);

    // The output key is derived, so a previous interrupted attempt's finished
    // file is already in the right place and this attempt can adopt it.
    const outputKey = renderOutputKey(job.projectId, job.idempotencyKey);
    const finalPath = absolutePath(outputKey);

    const adopted = await adoptExistingOutput(provider, finalPath, edl);
    if (adopted) {
      const assetId = await registerOutput({
        job,
        outputKey,
        probe: adopted,
        provider: provider.name,
      });
      const durationMs = Date.now() - startedAt.getTime();
      await finish(job.id, { outputAssetId: assetId, outputKey, probe: adopted, durationMs });
      return {
        renderJobId: job.id,
        outcome: "succeeded",
        outputAssetId: assetId,
        outputKey,
        durationMs,
      };
    }

    await setStage(job.id, RenderStage.PREPARING, 1);
    workDir = await mkdtemp(path.join(os.tmpdir(), "contentos-render-"));
    const scratchOutput = path.join(workDir, "output.mp4");

    const outcome = await provider.render({
      edl,
      sources,
      outputPath: scratchOutput,
      workDir,
      ...(options.signal ? { signal: options.signal } : {}),
      onProgress: ({ stage, percent }) => {
        // Fire and forget: a progress write must never fail a render, and the
        // next tick corrects anything a dropped update missed.
        void prisma.renderJob
          .update({ where: { id: job.id }, data: { stage, progress: percent } })
          .catch(() => {});
      },
    });

    verifyOutputProbe(outcome.probe, edl);

    await setStage(job.id, RenderStage.REGISTERING, 97);
    await mkdir(path.dirname(finalPath), { recursive: true });
    // Rename within the same volume is atomic; across volumes Node falls back to
    // a copy, which is why the probe happens before the move and not after.
    await rename(scratchOutput, finalPath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EXDEV") throw error;
      const { copyFile } = await import("node:fs/promises");
      await copyFile(scratchOutput, finalPath);
    });

    const assetId = await registerOutput({
      job,
      outputKey,
      probe: outcome.probe,
      provider: provider.name,
      log: outcome.log,
    });

    const durationMs = Date.now() - startedAt.getTime();
    await finish(job.id, {
      outputAssetId: assetId,
      outputKey,
      probe: outcome.probe,
      durationMs,
      log: outcome.log,
    });

    await recordActivity({
      action: activityActions.assetAnalyzed,
      message: `Rendered "${job.variant.label}" — ${Math.round(outcome.probe.durationSeconds ?? 0)}s, ${outcome.probe.video?.width}×${outcome.probe.video?.height}`,
      projectId: job.projectId,
      userId: null,
      actorType: ActorType.SYSTEM,
      entityType: "RenderJob",
      entityId: job.id,
      metadata: {
        provider: provider.name,
        durationMs,
        clips: edl.clips.length,
        outputKey,
      },
    });

    return {
      renderJobId: job.id,
      outcome: "succeeded",
      outputAssetId: assetId,
      outputKey,
      durationMs,
    };
  } catch (error) {
    const failure = classify(error);

    await prisma.renderJob.update({
      where: { id: job.id },
      data: {
        status:
          failure.kind === "CANCELLED" ? RenderStatus.CANCELLED : RenderStatus.FAILED,
        failureStage: failure.stage,
        errorKind: failure.kind,
        error: failure.message.slice(0, 2_000),
        logExcerpt: failure.log,
        completedAt: new Date(),
        ...(failure.kind === "CANCELLED" ? { cancelledAt: new Date() } : {}),
      },
    });

    return {
      renderJobId: job.id,
      outcome: failure.kind === "CANCELLED" ? "cancelled" : "failed",
      errorKind: failure.kind,
      error: failure.message,
      retryable: isRetryableRenderError(failure.kind),
    };
  } finally {
    if (workDir) {
      // Temporary files are large. Losing the directory is worth a log line, not
      // a failed render — the job's own record already says what happened.
      await rm(workDir, { recursive: true, force: true }).catch((error: unknown) => {
        console.warn(
          `[render] could not remove the scratch directory for job ${renderJobId}:`,
          error instanceof Error ? error.message : error,
        );
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Output verification
// ---------------------------------------------------------------------------

/**
 * What "it rendered" has to mean before the job is allowed to say so.
 *
 * ffmpeg exiting zero is not proof of a usable file — a broken filter chain can
 * still produce a zero-length container, and a mis-specified scale can produce a
 * perfectly valid file of the wrong shape that fails on upload instead.
 */
export function verifyOutputProbe(probe: MediaProbe, edl: RenderEdl): void {
  if (probe.sizeBytes <= 0) {
    throw new RenderError(
      "OUTPUT_INVALID",
      RenderStage.PROBING,
      "The rendered file is empty.",
    );
  }
  if (!/mp4|mov|m4a|isom/i.test(probe.formatName)) {
    throw new RenderError(
      "OUTPUT_INVALID",
      RenderStage.PROBING,
      `The rendered file is a ${probe.formatName}, not an MP4.`,
    );
  }
  if (!probe.video) {
    throw new RenderError(
      "OUTPUT_INVALID",
      RenderStage.PROBING,
      "The rendered file has no video stream.",
    );
  }
  if (probe.video.width !== edl.width || probe.video.height !== edl.height) {
    throw new RenderError(
      "OUTPUT_INVALID",
      RenderStage.PROBING,
      `The rendered file is ${probe.video.width}×${probe.video.height}; this cut was specified as ${edl.width}×${edl.height}.`,
    );
  }
  if (probe.video.height <= probe.video.width) {
    throw new RenderError(
      "OUTPUT_INVALID",
      RenderStage.PROBING,
      `The rendered file is not vertical (${probe.video.width}×${probe.video.height}).`,
    );
  }
  if (!/h264|avc/i.test(probe.video.codec)) {
    throw new RenderError(
      "OUTPUT_INVALID",
      RenderStage.PROBING,
      `The video stream is ${probe.video.codec}; short-form platforms expect H.264.`,
    );
  }
  if (probe.durationSeconds === null || probe.durationSeconds <= 0) {
    throw new RenderError(
      "OUTPUT_INVALID",
      RenderStage.PROBING,
      "The rendered file has no duration.",
    );
  }

  // A cut that came out at a fraction of its planned length usually means clips
  // were silently dropped, which reads as success and is not.
  const expected = edlDurationSeconds(edl);
  if (expected > 0 && probe.durationSeconds < expected * 0.5) {
    throw new RenderError(
      "OUTPUT_INVALID",
      RenderStage.PROBING,
      `The rendered file is ${probe.durationSeconds.toFixed(1)}s but the cut specifies ${expected.toFixed(1)}s. Clips were dropped.`,
    );
  }
}

/**
 * Reuses a finished file from an interrupted attempt.
 *
 * The output key is derived from the request, so a worker killed after the move
 * but before the asset row was written left a complete, correct file exactly
 * where this attempt would put one. Re-encoding it would waste minutes and
 * produce identical bytes.
 */
async function adoptExistingOutput(
  provider: EditingProvider,
  finalPath: string,
  edl: RenderEdl,
): Promise<MediaProbe | null> {
  try {
    const info = await stat(finalPath);
    if (info.size === 0) return null;
  } catch {
    return null;
  }

  try {
    const probe = await provider.probe(finalPath);
    verifyOutputProbe(probe, edl);
    return probe;
  } catch {
    // Present but not usable — a partial write from a kill mid-move. The render
    // proceeds and overwrites it.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Writes the ContentAsset for a finished cut.
 *
 * The output is an ordinary asset, which is the whole point: approval,
 * scheduling and publishing already work on assets, so a rendered cut needs no
 * special path through any of them. `origin` is what tells them apart.
 */
async function registerOutput(input: {
  job: {
    id: string;
    projectId: string;
    idempotencyKey: string;
    outputAssetId: string | null;
    variant: { id: string; assetId: string; label: string };
  };
  outputKey: string;
  probe: MediaProbe;
  provider: string;
  log?: string;
}): Promise<string> {
  if (input.job.outputAssetId) return input.job.outputAssetId;

  const existing = await prisma.contentAsset.findFirst({
    where: { projectId: input.job.projectId, storageKey: input.outputKey },
    select: { id: true },
  });
  if (existing) return existing.id;

  const source = await prisma.contentAsset.findUniqueOrThrow({
    where: { id: input.job.variant.assetId },
    select: { briefId: true, pillarId: true, uploaderId: true, title: true },
  });

  const checksum = await hashFile(absolutePath(input.outputKey));

  // The same bytes already in this project is not an error: it is the answer.
  const byChecksum = await prisma.contentAsset.findFirst({
    where: { projectId: input.job.projectId, checksum },
    select: { id: true },
  });
  if (byChecksum) return byChecksum.id;

  const asset = await prisma.contentAsset.create({
    data: {
      projectId: input.job.projectId,
      uploaderId: source.uploaderId,
      pillarId: source.pillarId,
      briefId: source.briefId,
      origin: AssetOrigin.RENDER,
      kind: AssetKind.VIDEO,
      status: AssetStatus.UPLOADED,
      title: `${source.title} — ${input.job.variant.label} (cut)`,
      originalFilename: `${input.job.idempotencyKey}.mp4`,
      storageKey: input.outputKey,
      mimeType: "video/mp4",
      sizeBytes: input.probe.sizeBytes,
      checksum,
      durationSeconds: input.probe.durationSeconds,
      width: input.probe.video?.width ?? null,
      height: input.probe.video?.height ?? null,
      aspectRatio:
        input.probe.video && input.probe.video.width > 0
          ? aspectLabel(input.probe.video.width, input.probe.video.height)
          : null,
      hasAudio: input.probe.audio !== null,
    },
  });

  return asset.id;
}

async function finish(
  renderJobId: string,
  input: {
    outputAssetId: string;
    outputKey: string;
    probe: MediaProbe;
    durationMs: number;
    log?: string;
  },
): Promise<void> {
  await prisma.renderJob.update({
    where: { id: renderJobId },
    data: {
      status: RenderStatus.SUCCEEDED,
      stage: RenderStage.DONE,
      progress: 100,
      outputAssetId: input.outputAssetId,
      outputKey: input.outputKey,
      outputProbe: input.probe as unknown as Prisma.InputJsonValue,
      durationMs: input.durationMs,
      completedAt: new Date(),
      failureStage: null,
      errorKind: null,
      error: null,
      ...(input.log ? { logExcerpt: input.log } : {}),
    },
  });
}

async function setStage(
  renderJobId: string,
  stage: RenderStage,
  progress: number,
): Promise<void> {
  await prisma.renderJob.update({
    where: { id: renderJobId },
    data: { stage, progress },
  });
}

async function resolveSources(assetIds: string[]): Promise<RenderSource[]> {
  const rows = await prisma.contentAsset.findMany({
    where: { id: { in: assetIds } },
    select: {
      id: true,
      kind: true,
      storageKey: true,
      mimeType: true,
      durationSeconds: true,
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  return assetIds.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new RenderError(
        "MISSING_ASSET",
        RenderStage.VALIDATING,
        `Source asset ${id} was deleted after this render was queued.`,
      );
    }
    return {
      assetId: row.id,
      absolutePath: absolutePath(row.storageKey),
      durationSeconds: row.durationSeconds,
      mimeType: row.mimeType,
      kind: row.kind,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classify(error: unknown): {
  kind: RenderErrorKind;
  stage: RenderStage;
  message: string;
  log: string | null;
} {
  if (error instanceof RenderError) {
    return {
      kind: error.kind,
      stage: error.stage,
      message: error.message,
      log: error.log,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "UNKNOWN", stage: RenderStage.ENCODING, message, log: null };
}

function throwIfCancelled(signal: AbortSignal | undefined, stage: RenderStage): void {
  if (signal?.aborted) {
    throw new RenderError("CANCELLED", stage, "The render was cancelled.");
  }
}

async function hashFile(absolute: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolute);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function aspectLabel(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export { STORAGE_ROOT };
