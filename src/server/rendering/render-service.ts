import { prisma } from "@/server/db";
import { RenderStage, RenderStatus } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { queueJobId, queues } from "@/server/jobs/queues";
import { buildEdlForVariant, type EdlOptions } from "./edl";
import { renderOutputKey } from "./render-runner";

/**
 * Queueing renders.
 *
 * Rendering never happens in a request. A cut of any length takes longer than a
 * browser will wait, and an HTTP timeout mid-encode would abandon a running
 * ffmpeg with nothing recording that it had started.
 *
 * Postgres is the source of truth here, as it is for publishing: the RenderJob
 * row exists before anything reaches Redis, so losing Redis delays a render but
 * never loses one.
 */

export type EnqueueResult = {
  renderJobId: string;
  /** True when an existing job was returned rather than a new one created. */
  reused: boolean;
  status: RenderStatus;
  /** Set when the reused job had already finished. */
  outputAssetId?: string;
  queued: boolean;
  /** Present when the job exists but could not reach the queue. */
  queueError?: string;
};

/**
 * Queues a render, or returns the one already covering this request.
 *
 * The idempotency key is a hash of the variant and the resolved EDL, so the
 * same cut requested twice — by an impatient operator, a duplicate queue
 * delivery, or a retry after a worker was killed — converges on one row and one
 * output file.
 */
export async function enqueueRender(input: {
  variantId: string;
  options?: EdlOptions;
  /** Re-run a finished job, producing a fresh file at the same key. */
  force?: boolean;
}): Promise<EnqueueResult> {
  const variant = await prisma.contentVariant.findUniqueOrThrow({
    where: { id: input.variantId },
    select: { id: true, asset: { select: { projectId: true } } },
  });
  const projectId = variant.asset.projectId;

  const built = await buildEdlForVariant(input.variantId, input.options ?? {});

  const existing = await prisma.renderJob.findUnique({
    where: { idempotencyKey: built.idempotencyKey },
  });

  if (existing && !input.force) {
    // Finished, or already on its way. Either way this request is satisfied by
    // the job that exists.
    if (
      existing.status === RenderStatus.SUCCEEDED ||
      existing.status === RenderStatus.PENDING ||
      existing.status === RenderStatus.RUNNING
    ) {
      return {
        renderJobId: existing.id,
        reused: true,
        status: existing.status,
        ...(existing.outputAssetId ? { outputAssetId: existing.outputAssetId } : {}),
        queued: existing.status !== RenderStatus.SUCCEEDED,
      };
    }
  }

  const data = {
    projectId,
    variantId: input.variantId,
    status: RenderStatus.PENDING,
    stage: RenderStage.QUEUED,
    idempotencyKey: built.idempotencyKey,
    config: built.edl as unknown as Prisma.InputJsonValue,
    sourceAssetIds: built.sources.map((source) => source.assetId),
    progress: 0,
    failureStage: null,
    errorKind: null,
    error: null,
    logExcerpt: null,
    cancelledAt: null,
    completedAt: null,
  };

  // A failed or cancelled job with this key is re-opened rather than duplicated,
  // so its attempt count and its history stay attached to the request.
  const job = await prisma.renderJob.upsert({
    where: { idempotencyKey: built.idempotencyKey },
    create: data,
    update: {
      ...data,
      // A nullable Json column is cleared with DbNull, not with a JS null —
      // Prisma reads a bare null as "leave this alone".
      ...(input.force
        ? {
            outputAssetId: null,
            outputKey: null,
            outputProbe: Prisma.DbNull,
          }
        : {}),
    },
  });

  const queued = await addToQueue(job.id);

  return {
    renderJobId: job.id,
    reused: Boolean(existing),
    status: RenderStatus.PENDING,
    queued: queued.ok,
    ...(queued.ok ? {} : { queueError: queued.error }),
  };
}

async function addToQueue(renderJobId: string): Promise<
  { ok: true } | { ok: false; error: string }
> {
  try {
    await queues.rendering().add(
      "render",
      { renderJobId },
      // The job id makes a duplicate `add` a no-op rather than a second render.
      { jobId: queueJobId("render", renderJobId) },
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Marks a job cancelled and asks the queue to forget it.
 *
 * A RUNNING job is marked too: the runner checks the flag between stages and
 * between clips, so a long encode stops at the next boundary rather than being
 * killed mid-write.
 */
export async function cancelRender(renderJobId: string): Promise<void> {
  await prisma.renderJob.update({
    where: { id: renderJobId },
    data: {
      status: RenderStatus.CANCELLED,
      cancelledAt: new Date(),
      completedAt: new Date(),
      errorKind: "CANCELLED",
      error: "Cancelled by an operator.",
    },
  });

  try {
    const job = await queues.rendering().getJob(queueJobId("render", renderJobId));
    await job?.remove();
  } catch {
    // Redis being unavailable does not un-cancel the job; the runner will see
    // the CANCELLED status and stop on its own.
  }
}

/**
 * Returns RUNNING jobs whose worker went away to the queue.
 *
 * A worker killed mid-render leaves a row saying RUNNING for ever. Nothing else
 * will ever touch it, so the sweeper reclaims anything that has been RUNNING for
 * longer than a render could plausibly take. The idempotency key means the
 * retry reuses the same output location — and adopts the finished file if the
 * kill happened after the encode.
 */
export async function reclaimStaleRenders(
  staleAfterMs = 45 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const stale = await prisma.renderJob.findMany({
    where: {
      status: RenderStatus.RUNNING,
      OR: [{ startedAt: { lt: cutoff } }, { startedAt: null }],
    },
    select: { id: true, attempts: true },
  });

  let requeued = 0;
  for (const job of stale) {
    // Bounded: a job that has already burned three attempts is a real problem,
    // not a flaky worker, and re-queueing it for ever hides that.
    if (job.attempts >= 3) {
      await prisma.renderJob.update({
        where: { id: job.id },
        data: {
          status: RenderStatus.FAILED,
          errorKind: "UNKNOWN",
          error:
            "The worker stopped mid-render three times. Something about this job is killing the process — check the logs before retrying.",
          failureStage: RenderStage.ENCODING,
          completedAt: new Date(),
        },
      });
      continue;
    }

    await prisma.renderJob.update({
      where: { id: job.id },
      data: { status: RenderStatus.PENDING, stage: RenderStage.QUEUED, progress: 0 },
    });
    const queued = await addToQueue(job.id);
    if (queued.ok) requeued += 1;
  }

  return requeued;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function latestRenderForVariant(variantId: string) {
  return prisma.renderJob.findFirst({
    where: { variantId },
    orderBy: { createdAt: "desc" },
    include: {
      outputAsset: {
        select: {
          id: true,
          storageKey: true,
          durationSeconds: true,
          width: true,
          height: true,
          sizeBytes: true,
        },
      },
    },
  });
}

export async function rendersForProject(projectId: string) {
  return prisma.renderJob.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      variant: { select: { id: true, label: true, hook: true, assetId: true } },
      outputAsset: { select: { id: true, storageKey: true, durationSeconds: true } },
    },
  });
}

/** The deterministic key a given request will write to, before it runs. */
export { renderOutputKey };
