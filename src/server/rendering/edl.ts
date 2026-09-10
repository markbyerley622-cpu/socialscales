import { createHash } from "node:crypto";
import { AssetKind, RenderStage } from "@/generated/prisma/enums";
import { prisma } from "@/server/db";
import { absolutePath, exists } from "@/server/storage";
import { readBeats } from "@/server/services/treatment-service";
import {
  RenderError,
  VERTICAL_1080x1920,
  type EdlClip,
  type RenderEdl,
  type RenderSource,
} from "./types";

/**
 * Turning a treatment into an edit decision list.
 *
 * A treatment's beats are positions on the *output* timeline — "0 to 4 seconds
 * is the hook". An EDL additionally says which frames of which source fill each
 * of those positions. That mapping is the thing this module decides, and it is
 * stored on the render job so a run is reproducible from the record rather than
 * from whatever the treatment says later.
 *
 * The mapping is deliberately simple: beats are filled in order from the
 * available sources, consuming each source as it goes. That is a defensible
 * default for an assembly tool and it is honest about being one — it is not
 * shot selection, and nothing here pretends it is.
 */

export type EdlOptions = {
  /** Overrides the sources. Defaults to the variant's asset plus its brief's. */
  sourceAssetIds?: string[];
  preserveSourceAudio?: boolean;
  normalizeAudio?: boolean;
  burnSubtitles?: boolean;
  backgroundAudioAssetId?: string | null;
  backgroundGainDb?: number;
};

export type BuiltEdl = {
  edl: RenderEdl;
  sources: RenderSource[];
  /** Stable across identical requests. Two runs of the same cut share it. */
  idempotencyKey: string;
};

/**
 * A rendered cut is only as long as the footage behind it. Where a beat asks
 * for more than a source can give, the clip is shortened rather than the run
 * failing — but never below this, because a 200ms flash is not a shot.
 */
const MIN_CLIP_SECONDS = 0.5;

export async function buildEdlForVariant(
  variantId: string,
  options: EdlOptions = {},
): Promise<BuiltEdl> {
  const variant = await prisma.contentVariant.findUniqueOrThrow({
    where: { id: variantId },
    include: {
      asset: {
        include: {
          brief: { select: { id: true } },
        },
      },
    },
  });

  const beats = readBeats(variant.treatment);
  if (beats.length === 0) {
    throw new RenderError(
      "INVALID_TIMING",
      RenderStage.VALIDATING,
      "This variant has no treatment, so there is nothing to cut. Write a treatment first.",
    );
  }

  const sourceIds = options.sourceAssetIds ?? (await defaultSourceIds(variant));
  const sources = await loadSources(sourceIds);

  if (sources.length === 0) {
    throw new RenderError(
      "MISSING_ASSET",
      RenderStage.VALIDATING,
      "No usable source footage was found for this variant.",
    );
  }

  const clips = assignClips(beats, sources);

  const edl: RenderEdl = {
    ...VERTICAL_1080x1920,
    clips,
    preserveSourceAudio: options.preserveSourceAudio ?? true,
    normalizeAudio: options.normalizeAudio ?? true,
    burnSubtitles: options.burnSubtitles ?? clips.some((clip) => clip.subtitle !== null),
    backgroundAudio: options.backgroundAudioAssetId
      ? {
          assetId: options.backgroundAudioAssetId,
          gainDb: options.backgroundGainDb ?? -18,
        }
      : null,
  };

  const used = new Set(clips.map((clip) => clip.assetId));
  if (edl.backgroundAudio) used.add(edl.backgroundAudio.assetId);

  return {
    edl,
    sources: sources.filter((source) => used.has(source.assetId)),
    idempotencyKey: renderIdempotencyKey(variantId, edl),
  };
}

/**
 * The variant's own asset first, then anything else made for the same brief.
 *
 * A brief is the unit of production, so several clips shot for one brief are the
 * natural pool for its cut.
 */
async function defaultSourceIds(variant: {
  assetId: string;
  asset: { briefId: string | null; projectId: string };
}): Promise<string[]> {
  const ids = [variant.assetId];
  if (variant.asset.briefId) {
    const siblings = await prisma.contentAsset.findMany({
      where: {
        briefId: variant.asset.briefId,
        id: { not: variant.assetId },
        kind: AssetKind.VIDEO,
        // A previous render is not raw footage for the next one.
        origin: "UPLOAD",
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    ids.push(...siblings.map((row) => row.id));
  }
  return ids;
}

async function loadSources(ids: string[]): Promise<RenderSource[]> {
  const rows = await prisma.contentAsset.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      kind: true,
      storageKey: true,
      mimeType: true,
      durationSeconds: true,
    },
  });

  const byId = new Map(rows.map((row) => [row.id, row]));
  const sources: RenderSource[] = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      throw new RenderError(
        "MISSING_ASSET",
        RenderStage.VALIDATING,
        `Source asset ${id} does not exist.`,
      );
    }
    if (row.kind !== AssetKind.VIDEO) {
      throw new RenderError(
        "UNSUPPORTED_SOURCE",
        RenderStage.VALIDATING,
        `Source asset ${id} is a ${row.kind.toLowerCase()}. This renderer assembles video clips; still images are not supported yet.`,
      );
    }
    sources.push({
      assetId: row.id,
      absolutePath: absolutePath(row.storageKey),
      durationSeconds: row.durationSeconds,
      mimeType: row.mimeType,
      kind: row.kind,
    });
  }

  return sources;
}

/**
 * Fills each beat from the source pool, consuming footage as it goes.
 *
 * When the pool runs dry the last source is reused from its start, which is the
 * least surprising behaviour for a cut whose treatment asks for more beats than
 * there is distinct footage — better a repeated shot than a failed render or a
 * silently truncated cut.
 */
export function assignClips(
  beats: Array<{
    startSeconds: number;
    endSeconds: number;
    onScreenText: string | null;
    voiceover: string | null;
  }>,
  sources: RenderSource[],
): EdlClip[] {
  const clips: EdlClip[] = [];
  // How much of each source has been consumed so far.
  const cursors = new Map<string, number>(sources.map((source) => [source.assetId, 0]));

  let sourceIndex = 0;

  for (const beat of beats) {
    const wanted = Math.max(MIN_CLIP_SECONDS, beat.endSeconds - beat.startSeconds);

    let chosen: RenderSource | null = null;
    let start = 0;
    let end = 0;

    // Walk the pool from where we left off, looking for one with room left.
    for (let offset = 0; offset < sources.length; offset += 1) {
      const candidate = sources[(sourceIndex + offset) % sources.length]!;
      const cursor = cursors.get(candidate.assetId) ?? 0;
      const available = candidate.durationSeconds ?? null;
      const remaining = available === null ? wanted : available - cursor;

      if (remaining >= MIN_CLIP_SECONDS) {
        chosen = candidate;
        start = cursor;
        end = available === null ? cursor + wanted : Math.min(cursor + wanted, available);
        sourceIndex = (sourceIndex + offset) % sources.length;
        break;
      }
    }

    if (!chosen) {
      // Everything is spent. Reuse the first source from the top rather than
      // dropping the beat, so the cut still matches the treatment's shape.
      chosen = sources[0]!;
      start = 0;
      end = Math.min(wanted, chosen.durationSeconds ?? wanted);
      cursors.set(chosen.assetId, end);
    } else {
      cursors.set(chosen.assetId, end);
      sourceIndex = (sourceIndex + 1) % sources.length;
    }

    clips.push({
      assetId: chosen.assetId,
      sourceStart: round3(start),
      sourceEnd: round3(Math.max(start + MIN_CLIP_SECONDS, end)),
      onScreenText: beat.onScreenText,
      subtitle: beat.voiceover,
      muteAudio: false,
    });
  }

  return clips;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks the EDL against the files on disk, before a single frame is decoded.
 *
 * This runs on every attempt rather than once at enqueue time: a source can be
 * deleted between queueing and running, and discovering that at ffmpeg's
 * decode error is a worse experience than being told which asset went missing.
 */
export async function validateEdl(
  edl: RenderEdl,
  sources: RenderSource[],
): Promise<void> {
  if (edl.clips.length === 0) {
    throw new RenderError(
      "INVALID_TIMING",
      RenderStage.VALIDATING,
      "The edit decision list has no clips.",
    );
  }

  const byId = new Map(sources.map((source) => [source.assetId, source]));

  for (const [index, clip] of edl.clips.entries()) {
    const source = byId.get(clip.assetId);
    if (!source) {
      throw new RenderError(
        "MISSING_ASSET",
        RenderStage.VALIDATING,
        `Clip ${index + 1} references asset ${clip.assetId}, which is not among this job's sources.`,
      );
    }
    if (clip.sourceStart < 0) {
      throw new RenderError(
        "INVALID_TIMING",
        RenderStage.VALIDATING,
        `Clip ${index + 1} starts at ${clip.sourceStart}s, before the beginning of the file.`,
      );
    }
    if (clip.sourceEnd <= clip.sourceStart) {
      throw new RenderError(
        "INVALID_TIMING",
        RenderStage.VALIDATING,
        `Clip ${index + 1} ends at ${clip.sourceEnd}s, at or before its ${clip.sourceStart}s start.`,
      );
    }
    // A tenth of a second of slack: container durations are approximate, and
    // refusing a clip that ends 20ms past a rounded duration helps nobody.
    if (
      source.durationSeconds !== null &&
      clip.sourceEnd > source.durationSeconds + 0.1
    ) {
      throw new RenderError(
        "INVALID_TIMING",
        RenderStage.VALIDATING,
        `Clip ${index + 1} asks for ${clip.sourceStart}s–${clip.sourceEnd}s of a source that is only ${source.durationSeconds}s long.`,
      );
    }
  }

  for (const source of sources) {
    if (!(await existsAtAbsolute(source.absolutePath))) {
      throw new RenderError(
        "MISSING_ASSET",
        RenderStage.VALIDATING,
        `The file for source asset ${source.assetId} is recorded but missing from storage.`,
      );
    }
  }

  if (edl.backgroundAudio && !byId.has(edl.backgroundAudio.assetId)) {
    throw new RenderError(
      "MISSING_ASSET",
      RenderStage.VALIDATING,
      `The background audio asset ${edl.backgroundAudio.assetId} is not among this job's sources.`,
    );
  }
}

async function existsAtAbsolute(absolute: string): Promise<boolean> {
  // Go back through the storage layer so the traversal guard still applies.
  const { STORAGE_ROOT } = await import("@/server/storage");
  const relative = absolute
    .replace(/\\/g, "/")
    .replace(`${STORAGE_ROOT.replace(/\\/g, "/")}/`, "");
  return exists(relative);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The identity of a render request.
 *
 * Two requests with the same variant and the same EDL are the same render, and
 * must not produce two outputs however many times a worker is interrupted. The
 * key is derived from the content of the request rather than assigned, so a
 * retry after a crash computes the same value without having to remember it.
 */
export function renderIdempotencyKey(variantId: string, edl: RenderEdl): string {
  return createHash("sha256")
    .update(variantId)
    .update(" ")
    .update(stableStringify(edl))
    .digest("hex")
    .slice(0, 40);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
