import path from "node:path";
import { prisma } from "@/server/db";
import { getAiProvider } from "@/server/ai";
import { probeMedia } from "@/server/media/probe";
import { validateUpload, type MediaType } from "@/server/media/validate";
import { sha256Hex } from "@/server/security/crypto";
import { storageKeys, writeBuffer } from "@/server/storage";
import { activityActions, recordActivity } from "@/server/activity/log";
import { buildBrandContext } from "./brand-context";
import {
  ActorType,
  AssetStatus,
  type ContentFormat,
} from "@/generated/prisma/enums";
import type { ContentAsset } from "@/generated/prisma/client";

/**
 * Content ingestion and enrichment.
 *
 * Upload is deliberately synchronous up to "the bytes are safely on disk and a
 * row exists". Analysis is a separate step so a slow provider never blocks the
 * upload, and so re-analysis is possible without re-uploading.
 */

export class DuplicateAssetError extends Error {
  constructor(readonly existing: ContentAsset) {
    super(
      `That file is already in this project as "${existing.title}". Uploading it again would risk publishing duplicate content.`,
    );
    this.name = "DuplicateAssetError";
  }
}

export type CreateAssetInput = {
  projectId: string;
  uploaderId: string | null;
  filename: string;
  declaredMime?: string;
  data: Buffer;
  title?: string;
  pillarId?: string | null;
};

/**
 * Validates, fingerprints, stores and records one uploaded file.
 * Deduplicates on content hash within the project.
 */
export async function createAsset(
  input: CreateAssetInput,
): Promise<{ asset: ContentAsset; mediaType: MediaType }> {
  const mediaType = validateUpload({
    head: input.data.subarray(0, 32),
    sizeBytes: input.data.byteLength,
    declaredMime: input.declaredMime,
    filename: input.filename,
  });

  const checksum = sha256Hex(input.data);

  const existing = await prisma.contentAsset.findUnique({
    where: { projectId_checksum: { projectId: input.projectId, checksum } },
  });
  if (existing) throw new DuplicateAssetError(existing);

  const probe = probeMedia(input.data, mediaType.kind);
  const storageKey = storageKeys.media(
    input.projectId,
    checksum,
    mediaType.extension,
  );
  await writeBuffer(storageKey, input.data);

  const title =
    input.title?.trim() ||
    path
      .basename(input.filename, path.extname(input.filename))
      .replace(/[-_]+/g, " ")
      .trim() ||
    "Untitled";

  const asset = await prisma.contentAsset.create({
    data: {
      projectId: input.projectId,
      uploaderId: input.uploaderId,
      pillarId: input.pillarId ?? null,
      kind: mediaType.kind,
      status: AssetStatus.UPLOADED,
      title,
      originalFilename: input.filename,
      storageKey,
      mimeType: mediaType.mimeType,
      sizeBytes: input.data.byteLength,
      checksum,
      durationSeconds: probe.durationSeconds,
      width: probe.width,
      height: probe.height,
      aspectRatio: probe.aspectRatio,
      hasAudio: probe.hasAudio,
    },
  });

  await recordActivity({
    action: activityActions.assetUploaded,
    message: `Uploaded ${input.filename}`,
    projectId: input.projectId,
    userId: input.uploaderId,
    actorType: input.uploaderId ? ActorType.USER : ActorType.SYSTEM,
    entityType: "ContentAsset",
    entityId: asset.id,
    metadata: {
      sizeBytes: asset.sizeBytes,
      durationSeconds: asset.durationSeconds,
      aspectRatio: asset.aspectRatio,
    },
  });

  return { asset, mediaType };
}

// ---------------------------------------------------------------------------
// Analysis + suggestion
// ---------------------------------------------------------------------------

export type AnalyzeResult = {
  analysisId: string;
  format: ContentFormat;
  variantIds: string[];
};

/**
 * Runs the configured AI provider over an asset and writes the analysis plus a
 * set of draft variants. Idempotent in effect: calling it again appends a new
 * analysis and a new batch of variants rather than mutating existing ones, so
 * nothing the operator has edited is ever silently overwritten.
 */
export async function analyzeAsset(input: {
  assetId: string;
  userId: string | null;
  variantCount?: number;
}): Promise<AnalyzeResult> {
  const asset = await prisma.contentAsset.findUniqueOrThrow({
    where: { id: input.assetId },
    include: { pillar: true, variants: { select: { id: true } } },
  });

  await prisma.contentAsset.update({
    where: { id: asset.id },
    data: { status: AssetStatus.ANALYZING },
  });

  try {
    const brand = await buildBrandContext(asset.projectId);
    const provider = getAiProvider();

    const facts = {
      title: asset.title,
      originalFilename: asset.originalFilename,
      kind: asset.kind,
      durationSeconds: asset.durationSeconds,
      width: asset.width,
      height: asset.height,
      aspectRatio: asset.aspectRatio,
      hasAudio: asset.hasAudio,
      pillar: asset.pillar?.name ?? null,
    } as const;

    const analysis = await provider.analyzeAsset({ asset: facts, brand });

    const suggestions = await provider.suggestCopy({
      asset: facts,
      brand,
      analysis,
      count: input.variantCount ?? 3,
    });

    const analysisRow = await prisma.aIAnalysis.create({
      data: {
        assetId: asset.id,
        provider: provider.name,
        model: provider.model,
        format: analysis.format,
        topic: analysis.topic,
        likelyAudience: analysis.likelyAudience,
        visualSummary: analysis.visualSummary,
        transcript: analysis.transcript,
        raw: analysis.raw as object,
      },
    });

    // The first suggestion of the first batch becomes the control variant.
    const hasControl = asset.variants.length > 0;

    const variantIds: string[] = [];
    for (const [index, suggestion] of suggestions.entries()) {
      const scorecard = provider.scoreCopy({ suggestion, brand, analysis });
      const variant = await prisma.contentVariant.create({
        data: {
          assetId: asset.id,
          createdById: input.userId,
          label: suggestion.label,
          hook: suggestion.hook,
          caption: suggestion.caption,
          hashtags: suggestion.hashtags,
          cta: suggestion.cta,
          isControl: !hasControl && index === 0,
          scorecard: scorecard as unknown as object,
        },
      });
      variantIds.push(variant.id);
    }

    await prisma.contentAsset.update({
      where: { id: asset.id },
      data: { status: AssetStatus.ANALYZED },
    });

    await recordActivity({
      action: activityActions.assetAnalyzed,
      message: `AI generated metadata for "${asset.title}" (${suggestions.length} variants)`,
      projectId: asset.projectId,
      userId: input.userId,
      actorType: ActorType.SYSTEM,
      entityType: "ContentAsset",
      entityId: asset.id,
      metadata: {
        provider: provider.name,
        format: analysis.format,
        variantCount: suggestions.length,
      },
    });

    return {
      analysisId: analysisRow.id,
      format: analysis.format,
      variantIds,
    };
  } catch (error) {
    await prisma.contentAsset.update({
      where: { id: asset.id },
      data: { status: AssetStatus.ANALYSIS_FAILED },
    });
    await recordActivity({
      action: activityActions.assetAnalysisFailed,
      message: `Analysis failed for "${asset.title}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      projectId: asset.projectId,
      userId: input.userId,
      entityType: "ContentAsset",
      entityId: asset.id,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export async function createVariant(input: {
  assetId: string;
  userId: string | null;
  label: string;
  hook: string;
  caption: string;
  hashtags: string[];
  cta: string;
}): Promise<string> {
  const asset = await prisma.contentAsset.findUniqueOrThrow({
    where: { id: input.assetId },
    select: { projectId: true, title: true },
  });

  const brand = await buildBrandContext(asset.projectId);
  const provider = getAiProvider();
  const scorecard = provider.scoreCopy({
    suggestion: {
      label: input.label,
      hook: input.hook,
      caption: input.caption,
      hashtags: input.hashtags,
      cta: input.cta,
    },
    brand,
    analysis: {
      format: "UNKNOWN",
      topic: null,
      likelyAudience: null,
      visualSummary: null,
      transcript: null,
      raw: {},
    },
  });

  const variant = await prisma.contentVariant.create({
    data: {
      assetId: input.assetId,
      createdById: input.userId,
      label: input.label,
      hook: input.hook,
      caption: input.caption,
      hashtags: input.hashtags,
      cta: input.cta,
      scorecard: scorecard as unknown as object,
    },
  });

  await recordActivity({
    action: activityActions.variantCreated,
    message: `Added variant "${input.label}" to "${asset.title}"`,
    projectId: asset.projectId,
    userId: input.userId,
    entityType: "ContentVariant",
    entityId: variant.id,
  });

  return variant.id;
}

export async function updateVariant(input: {
  variantId: string;
  userId: string | null;
  hook: string;
  caption: string;
  hashtags: string[];
  cta: string;
}): Promise<void> {
  const variant = await prisma.contentVariant.findUniqueOrThrow({
    where: { id: input.variantId },
    include: { asset: { select: { projectId: true, title: true } } },
  });

  const brand = await buildBrandContext(variant.asset.projectId);
  const provider = getAiProvider();
  const scorecard = provider.scoreCopy({
    suggestion: {
      label: variant.label,
      hook: input.hook,
      caption: input.caption,
      hashtags: input.hashtags,
      cta: input.cta,
    },
    brand,
    analysis: {
      format: "UNKNOWN",
      topic: null,
      likelyAudience: null,
      visualSummary: null,
      transcript: null,
      raw: {},
    },
  });

  await prisma.contentVariant.update({
    where: { id: input.variantId },
    data: {
      hook: input.hook,
      caption: input.caption,
      hashtags: input.hashtags,
      cta: input.cta,
      scorecard: scorecard as unknown as object,
    },
  });

  await recordActivity({
    action: activityActions.variantUpdated,
    message: `Edited variant "${variant.label}" on "${variant.asset.title}"`,
    projectId: variant.asset.projectId,
    userId: input.userId,
    entityType: "ContentVariant",
    entityId: input.variantId,
  });
}

/** Keeps the project's hashtag vocabulary current as variants are published. */
export async function recordHashtagUsage(
  projectId: string,
  hashtags: string[],
): Promise<void> {
  for (const raw of hashtags) {
    const tag = raw.startsWith("#") ? raw : `#${raw}`;
    await prisma.hashtag.upsert({
      where: { projectId_tag: { projectId, tag } },
      create: { projectId, tag, usageCount: 1 },
      update: { usageCount: { increment: 1 } },
    });
  }
}
