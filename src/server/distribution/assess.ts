import { prisma } from "@/server/db";
import {
  AssetOrigin,
  DistributionFit,
  DistributionStatus,
  Platform,
} from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { getAdapter } from "@/server/platforms/registry";
import type { ValidationIssue } from "@/server/platforms/types";

/**
 * Deciding whether a cut can go to a platform, and what it should say there.
 *
 * The adapters already declare their own constraints and compose their own
 * captions, and they are the authority on both. This module's job is to ask
 * them, sort the answer into "fine", "fixable by re-rendering" and "not
 * fixable", and write down what it found — so a blocked destination is a stated
 * fact rather than something discovered mid-publish.
 */

export type TargetAssessment = {
  platform: Platform;
  fit: DistributionFit;
  issues: ValidationIssue[];
  /** The caption exactly as this platform should receive it. */
  caption: string;
  hashtags: string[];
  /** Present when a derivative render would fix the fit. */
  optimization: OptimizationPlan | null;
  /** True when this platform can publish without a person driving it. */
  automatable: boolean;
  /** Why it is not automatable, when it is not. */
  manualReason: string | null;
};

export type OptimizationPlan = {
  kind: "TRIM";
  /** The runtime the derivative should have, in seconds. */
  targetSeconds: number;
  reason: string;
};

/**
 * Which validation failures a re-render can fix.
 *
 * Duration is the one. Size follows from duration and bitrate, and every render
 * this system produces is already 9:16 H.264/AAC — so a MIME or aspect failure
 * means something upstream is wrong, not that the cut needs another pass.
 */
export function assessTarget(input: {
  platform: Platform;
  asset: {
    mimeType: string;
    sizeBytes: number;
    durationSeconds: number | null;
    aspectRatio: string | null;
  };
  variant: { caption: string; hashtags: string[]; cta: string };
}): TargetAssessment {
  const adapter = getAdapter(input.platform);
  const verdict = adapter.validateMedia({
    mimeType: input.asset.mimeType,
    sizeBytes: input.asset.sizeBytes,
    durationSeconds: input.asset.durationSeconds,
    aspectRatio: input.asset.aspectRatio,
  });

  const errors = verdict.issues.filter((issue) => issue.severity === "error");
  const max = adapter.constraints.maxDurationSeconds;
  const tooLong =
    max !== null &&
    input.asset.durationSeconds !== null &&
    input.asset.durationSeconds > max;

  // Only the duration error is fixable here. If anything else failed, a trimmed
  // derivative would fail for the same reason and the operator would have
  // watched a render run for nothing.
  const otherErrors = errors.filter((issue) => !isDurationIssue(issue));

  let fit: DistributionFit;
  let optimization: OptimizationPlan | null = null;

  if (errors.length === 0) {
    fit = DistributionFit.READY;
  } else if (tooLong && otherErrors.length === 0) {
    fit = DistributionFit.NEEDS_OPTIMIZATION;
    optimization = {
      kind: "TRIM",
      // A whisker under the limit: platforms round, and a cut that lands exactly
      // on the boundary gets rejected often enough to be worth avoiding.
      targetSeconds: Math.max(1, max! - 0.5),
      reason: `${Math.round(input.asset.durationSeconds!)}s exceeds ${adapter.label}'s ${max}s maximum.`,
    };
  } else {
    fit = DistributionFit.BLOCKED;
  }

  const hashtags = input.variant.hashtags.slice(0, adapter.constraints.hashtagMaxCount);
  const caption = adapter.composeCaption({
    caption: input.variant.caption,
    hashtags,
    cta: input.variant.cta,
  });

  const publishMode = adapter.capabilities.publish;
  const automatable = publishMode !== "UNSUPPORTED";

  return {
    platform: input.platform,
    fit,
    issues: verdict.issues,
    caption,
    hashtags,
    optimization,
    automatable,
    manualReason: automatable
      ? null
      : `${adapter.label} has no implemented publish path in this system, so it is a manual upload.`,
  };
}

function isDurationIssue(issue: ValidationIssue): boolean {
  return /exceeds the \d+s|shorter than|under the \d+s/i.test(issue.message);
}

// ---------------------------------------------------------------------------
// Persisting an assessment
// ---------------------------------------------------------------------------

export type AssessmentResult = {
  assetId: string;
  variantId: string;
  targets: Array<TargetAssessment & { distributionId: string; status: DistributionStatus }>;
};

/**
 * Assesses a rendered cut against every platform this project has an account
 * for, and records the result.
 *
 * Re-assessing updates the existing row rather than creating a second opinion —
 * but never walks back a destination that has already been dispatched or
 * exported, because that already happened and re-running an assessment does not
 * un-happen it.
 */
export async function assessDistribution(input: {
  assetId: string;
  variantId: string;
  /** Defaults to the platforms this project has connected accounts for. */
  platforms?: Platform[];
}): Promise<AssessmentResult> {
  const asset = await prisma.contentAsset.findUniqueOrThrow({
    where: { id: input.assetId },
    select: {
      id: true,
      projectId: true,
      origin: true,
      mimeType: true,
      sizeBytes: true,
      durationSeconds: true,
      aspectRatio: true,
    },
  });

  const variant = await prisma.contentVariant.findUniqueOrThrow({
    where: { id: input.variantId },
    select: { id: true, caption: true, hashtags: true, cta: true },
  });

  const platforms = input.platforms ?? (await connectedPlatforms(asset.projectId));

  const targets: AssessmentResult["targets"] = [];

  for (const platform of platforms) {
    const assessment = assessTarget({ platform, asset, variant });

    const existing = await prisma.distribution.findUnique({
      where: { assetId_platform: { assetId: asset.id, platform } },
      select: { id: true, status: true },
    });

    // A dispatched or exported destination is history. Refresh the assessment
    // fields so the record stays accurate, but leave the status alone.
    const keepStatus =
      existing?.status === DistributionStatus.DISPATCHED ||
      existing?.status === DistributionStatus.EXPORTED;

    const row = await prisma.distribution.upsert({
      where: { assetId_platform: { assetId: asset.id, platform } },
      create: {
        projectId: asset.projectId,
        variantId: variant.id,
        assetId: asset.id,
        platform,
        fit: assessment.fit,
        issues: assessment.issues as unknown as Prisma.InputJsonValue,
        caption: assessment.caption,
        hashtags: assessment.hashtags,
      },
      update: {
        variantId: variant.id,
        fit: assessment.fit,
        issues: assessment.issues as unknown as Prisma.InputJsonValue,
        caption: assessment.caption,
        hashtags: assessment.hashtags,
        ...(keepStatus ? {} : { status: DistributionStatus.ASSESSED }),
      },
    });

    targets.push({ ...assessment, distributionId: row.id, status: row.status });
  }

  return { assetId: asset.id, variantId: variant.id, targets };
}

async function connectedPlatforms(projectId: string): Promise<Platform[]> {
  const accounts = await prisma.socialAccount.findMany({
    where: { projectId },
    select: { platform: true },
    distinct: ["platform"],
  });
  return accounts.map((account) => account.platform);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function distributionsForVariant(variantId: string) {
  return prisma.distribution.findMany({
    where: { variantId },
    orderBy: { platform: "asc" },
    include: {
      asset: {
        select: {
          id: true,
          storageKey: true,
          origin: true,
          durationSeconds: true,
          sizeBytes: true,
        },
      },
      post: { select: { id: true, status: true, scheduledFor: true } },
    },
  });
}

export async function distributionsForProject(projectId: string) {
  return prisma.distribution.findMany({
    where: { projectId },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      variant: { select: { id: true, label: true, hook: true, assetId: true } },
      asset: {
        select: { id: true, storageKey: true, origin: true, durationSeconds: true },
      },
      post: { select: { id: true, status: true, scheduledFor: true } },
    },
  });
}

/** Cuts that are rendered but have not been assessed for anywhere yet. */
export async function undistributedRenders(projectId: string) {
  return prisma.contentAsset.findMany({
    where: {
      projectId,
      origin: AssetOrigin.RENDER,
      distributions: { none: {} },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, createdAt: true, durationSeconds: true },
  });
}
