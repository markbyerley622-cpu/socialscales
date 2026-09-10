import path from "node:path";
import { prisma } from "@/server/db";
import { heuristicProvider } from "@/server/ai/heuristic-provider";
import {
  assetAnalysisPrompt,
  copyVariantsPrompt,
  runAiOperation,
} from "@/server/ai/orchestration";
import type { ModelProvider } from "@/server/ai/orchestration";
import { probeMedia } from "@/server/media/probe";
import { validateUpload, type MediaType } from "@/server/media/validate";
import { sha256Hex } from "@/server/security/crypto";
import { storageKeys, writeBuffer } from "@/server/storage";
import { activityActions, recordActivity } from "@/server/activity/log";
import { buildBrandContext } from "./brand-context";
import {
  ActorType,
  AssetStatus,
  BriefStatus,
  Confidence,
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
  /** Never claims more than the input supports. */
  confidence: Confidence;
  /** True when a language model produced this, false when rules did. */
  usedModel: boolean;
};

export class AnalysisFailedError extends Error {
  constructor(
    readonly errorKind: string,
    message: string,
  ) {
    super(message);
    this.name = "AnalysisFailedError";
  }
}

/**
 * Analyses an asset and drafts copy variants for it.
 *
 * Both steps go through `runAiOperation`, so each one leaves an `AIJob` with its
 * provider, prompt version, cost and latency, and each result is schema-validated
 * before anything is written. Nothing here calls a model directly.
 *
 * Idempotent in effect: calling it again appends a new analysis and a new batch
 * of variants rather than mutating existing ones, so nothing an operator has
 * edited is ever silently overwritten.
 */
export async function analyzeAsset(input: {
  assetId: string;
  userId: string | null;
  variantCount?: number;
  /** Test seam, matching the strategy engine and content director. */
  provider?: ModelProvider;
}): Promise<AnalyzeResult> {
  const asset = await prisma.contentAsset.findUniqueOrThrow({
    where: { id: input.assetId },
    include: {
      pillar: true,
      variants: { select: { id: true } },
      project: { select: { workspaceId: true } },
      brief: { select: { id: true } },
    },
  });

  await prisma.contentAsset.update({
    where: { id: asset.id },
    data: { status: AssetStatus.ANALYZING },
  });

  try {
    const brand = await buildBrandContext(asset.projectId);
    const workspaceId = asset.project.workspaceId;

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

    const analysed = await runAiOperation({
      prompt: assetAnalysisPrompt,
      input: { asset: facts, brand },
      workspaceId,
      projectId: asset.projectId,
      ...(input.provider ? { provider: input.provider } : {}),
    });
    if (!analysed.ok) {
      throw new AnalysisFailedError(analysed.errorKind, analysed.message);
    }

    const analysis = analysed.value;
    // The copy prompt takes the older AnalysisResult shape, which carries a
    // transcript the analysis prompt cannot fill — it has never seen the media.
    // Null is the honest value there, not an empty string.
    const forCopy = {
      format: analysis.format as ContentFormat,
      topic: analysis.topic,
      likelyAudience: analysis.likelyAudience,
      visualSummary: analysis.visualSummary,
      transcript: null,
      raw: analysis as unknown as Record<string, unknown>,
    };

    const written = await runAiOperation({
      prompt: copyVariantsPrompt,
      input: {
        asset: facts,
        brand,
        analysis: forCopy,
        count: input.variantCount ?? 3,
      },
      workspaceId,
      projectId: asset.projectId,
      ...(input.provider ? { provider: input.provider } : {}),
    });
    if (!written.ok) {
      throw new AnalysisFailedError(written.errorKind, written.message);
    }

    const analysisRow = await prisma.aIAnalysis.create({
      data: {
        assetId: asset.id,
        provider: analysed.job.provenance.providerName,
        model: analysed.job.provenance.model,
        format: analysis.format as ContentFormat,
        topic: analysis.topic,
        likelyAudience: analysis.likelyAudience,
        visualSummary: analysis.visualSummary,
        transcript: null,
        confidence: toConfidence(analysis.confidence),
        basis: analysis.basis,
        unknowns: analysis.unknowns,
        promptVersion: `${analysed.job.provenance.promptName}@${analysed.job.provenance.promptVersion}`,
        aiJobId: analysed.job.id,
        raw: analysis as unknown as object,
      },
    });

    // The first suggestion of the first batch becomes the control variant.
    const hasControl = asset.variants.length > 0;

    const variantIds: string[] = [];
    for (const [index, suggestion] of written.value.variants.entries()) {
      // Scoring stays rule-based on purpose: these are writing heuristics and
      // the UI labels them as such. Asking a model to score its own copy would
      // produce a number that reads like a prediction and is not one.
      const scorecard = heuristicProvider.scoreCopy({
        suggestion,
        brand,
        analysis: forCopy,
      });
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

    // An asset made for a brief moves that brief along, so the plan shows what
    // is actually in production rather than only what was asked for.
    if (asset.brief) {
      await prisma.contentBrief.update({
        where: { id: asset.brief.id },
        data: { status: BriefStatus.READY },
      });
    }

    await recordActivity({
      action: activityActions.assetAnalyzed,
      message: `${analysed.job.provenance.deterministic ? "Rules" : analysed.job.provenance.model} generated metadata for "${asset.title}" (${variantIds.length} variants, ${analysis.confidence.toLowerCase()} confidence)`,
      projectId: asset.projectId,
      userId: input.userId,
      actorType: ActorType.SYSTEM,
      entityType: "ContentAsset",
      entityId: asset.id,
      metadata: {
        provider: analysed.job.provenance.providerName,
        deterministic: analysed.job.provenance.deterministic,
        promptVersion: analysed.job.provenance.promptVersion,
        format: analysis.format,
        confidence: analysis.confidence,
        variantCount: variantIds.length,
        costUsd: analysed.job.costUsd + written.job.costUsd,
      },
    });

    return {
      analysisId: analysisRow.id,
      format: analysis.format as ContentFormat,
      variantIds,
      confidence: toConfidence(analysis.confidence),
      usedModel: !analysed.job.provenance.deterministic,
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

function toConfidence(value: "LOW" | "MEDIUM" | "HIGH"): Confidence {
  return value === "HIGH"
    ? Confidence.HIGH
    : value === "MEDIUM"
      ? Confidence.MEDIUM
      : Confidence.LOW;
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
  // Rule-based on purpose: the scorecard is a set of writing heuristics, not a
  // prediction, and the UI says so. It makes no model call.
  const scorecard = heuristicProvider.scoreCopy({
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
  // Rule-based on purpose: the scorecard is a set of writing heuristics, not a
  // prediction, and the UI says so. It makes no model call.
  const scorecard = heuristicProvider.scoreCopy({
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
