import { prisma } from "@/server/db";
import {
  ActorType,
  DistributionFit,
  DistributionRoute,
  DistributionStatus,
  Platform,
} from "@/generated/prisma/enums";
import { activityActions, recordActivity } from "@/server/activity/log";
import { getAdapter } from "@/server/platforms/registry";
import { createPost } from "@/server/services/post-service";
import { enqueueRender } from "@/server/rendering";
import { buildEdlForVariant } from "@/server/rendering/edl";
import { assessDistribution } from "./assess";

/**
 * Getting a cut out of the building.
 *
 * Two routes, and they are genuinely different things rather than two buttons
 * for the same one:
 *
 *  - **Automated** hands the cut to the existing publish path — a Post with its
 *    per-platform destinations, the approval policy, the schedule and the
 *    worker. Nothing about that path changed for Phase 8.
 *  - **Manual** hands it to a person: the file to download and the caption the
 *    automated path would have sent, recorded so an uploaded cut is not
 *    invisible to the system afterwards.
 *
 * A destination is never dispatched or exported while it does not fit. That is
 * the whole point of assessing first.
 */

export type DispatchResult =
  | { ok: true; postId: string; platforms: Platform[]; scheduledFor: Date | null }
  | { ok: false; reason: string };

/**
 * Routes a cut to the automated publish path.
 *
 * The Post is created from the rendered asset, so everything downstream — media
 * validation per platform, the approval decision, the queue, the browser
 * publisher, verification — behaves exactly as it does for an uploaded file.
 */
export async function dispatchAutomated(input: {
  assetId: string;
  variantId: string;
  platforms: Platform[];
  scheduledFor?: Date | null;
  userId: string | null;
}): Promise<DispatchResult> {
  if (input.platforms.length === 0) {
    return { ok: false, reason: "Pick at least one destination." };
  }

  const rows = await prisma.distribution.findMany({
    where: { assetId: input.assetId, platform: { in: input.platforms } },
  });

  const missing = input.platforms.filter(
    (platform) => !rows.some((row) => row.platform === platform),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `${missing.join(", ")} has not been assessed for this cut. Assess it first.`,
    };
  }

  const unfit = rows.filter((row) => row.fit !== DistributionFit.READY);
  if (unfit.length > 0) {
    return {
      ok: false,
      reason: `${unfit.map((row) => row.platform).join(", ")} does not accept this cut as it stands: ${unfit[0]!.fit === DistributionFit.NEEDS_OPTIMIZATION ? "it needs an optimised render first." : "the problem cannot be fixed by re-rendering."}`,
    };
  }

  const notAutomatable = rows.filter(
    (row) => getAdapter(row.platform).capabilities.publish === "UNSUPPORTED",
  );
  if (notAutomatable.length > 0) {
    return {
      ok: false,
      reason: `${notAutomatable.map((row) => getAdapter(row.platform).label).join(", ")} has no automated publish path. Export it for a manual upload instead.`,
    };
  }

  const asset = await prisma.contentAsset.findUniqueOrThrow({
    where: { id: input.assetId },
    select: { projectId: true, title: true },
  });

  const accounts = await prisma.socialAccount.findMany({
    where: { projectId: asset.projectId, platform: { in: input.platforms } },
    select: { id: true, platform: true },
  });
  const withoutAccount = input.platforms.filter(
    (platform) => !accounts.some((account) => account.platform === platform),
  );
  if (withoutAccount.length > 0) {
    return {
      ok: false,
      reason: `No connected account for ${withoutAccount.join(", ")}.`,
    };
  }

  // createPost carries the existing per-platform media validation, the approval
  // policy and the queueing. This is the integration point, and it is the only
  // one Phase 8 needed.
  const post = await createPost({
    projectId: asset.projectId,
    assetId: input.assetId,
    variantId: input.variantId,
    socialAccountIds: accounts.map((account) => account.id),
    userId: input.userId,
    scheduledFor: input.scheduledFor ?? null,
  });

  await prisma.distribution.updateMany({
    where: { assetId: input.assetId, platform: { in: input.platforms } },
    data: {
      status: DistributionStatus.DISPATCHED,
      route: DistributionRoute.AUTOMATED,
      postId: post.postId,
      dispatchedAt: new Date(),
    },
  });

  await recordActivity({
    action: activityActions.postCreated,
    message: `Dispatched the rendered cut of "${asset.title}" to ${input.platforms.join(", ")}`,
    projectId: asset.projectId,
    userId: input.userId,
    actorType: input.userId ? ActorType.USER : ActorType.SYSTEM,
    entityType: "Post",
    entityId: post.postId,
    metadata: { route: "AUTOMATED", platforms: input.platforms },
  });

  return {
    ok: true,
    postId: post.postId,
    platforms: input.platforms,
    scheduledFor: input.scheduledFor ?? null,
  };
}

// ---------------------------------------------------------------------------
// Manual
// ---------------------------------------------------------------------------

export type ExportPackage = {
  distributionId: string;
  platform: Platform;
  platformLabel: string;
  /** Where the operator downloads the file from. */
  downloadUrl: string;
  filename: string;
  /** Exactly what the automated path would have sent. */
  caption: string;
  hashtags: string[];
  durationSeconds: number | null;
  sizeBytes: number;
  /** Anything the platform will complain about, restated for a person. */
  warnings: string[];
  /** What the platform's own composer needs, in the order it asks for it. */
  steps: string[];
};

/**
 * Prepares a cut for a person to upload, and records that it happened.
 *
 * The caption is the one the adapter composed, not the raw variant text — a
 * manual upload should say the same thing an automated one would, including the
 * truncation that platform's limit forces.
 */
export async function exportForManualUpload(input: {
  distributionId: string;
  userId: string | null;
}): Promise<{ ok: true; package: ExportPackage } | { ok: false; reason: string }> {
  const row = await prisma.distribution.findUniqueOrThrow({
    where: { id: input.distributionId },
    include: {
      asset: {
        select: {
          storageKey: true,
          durationSeconds: true,
          sizeBytes: true,
          originalFilename: true,
        },
      },
    },
  });

  if (row.fit === DistributionFit.BLOCKED) {
    return {
      ok: false,
      reason:
        "This cut fails a constraint that re-rendering cannot fix, so exporting it would just move the rejection to the platform's uploader.",
    };
  }
  if (row.fit === DistributionFit.NEEDS_OPTIMIZATION) {
    return {
      ok: false,
      reason:
        "This cut is too long for this platform. Optimise it first — the derivative render is what should be uploaded.",
    };
  }

  const adapter = getAdapter(row.platform);

  await prisma.distribution.update({
    where: { id: row.id },
    data: {
      status: DistributionStatus.EXPORTED,
      route: DistributionRoute.MANUAL,
      exportedAt: new Date(),
      exportedById: input.userId,
    },
  });

  await recordActivity({
    action: activityActions.postCreated,
    message: `Exported a rendered cut for manual upload to ${adapter.label}`,
    projectId: row.projectId,
    userId: input.userId,
    actorType: input.userId ? ActorType.USER : ActorType.SYSTEM,
    entityType: "Distribution",
    entityId: row.id,
    metadata: { route: "MANUAL", platform: row.platform },
  });

  const warnings = (row.issues as Array<{ severity: string; message: string }> | null) ?? [];

  return {
    ok: true,
    package: {
      distributionId: row.id,
      platform: row.platform,
      platformLabel: adapter.label,
      downloadUrl: `/api/media/${row.asset.storageKey}`,
      filename: row.asset.originalFilename,
      caption: row.caption,
      hashtags: row.hashtags,
      durationSeconds: row.asset.durationSeconds,
      sizeBytes: row.asset.sizeBytes,
      warnings: warnings
        .filter((issue) => issue.severity === "warning")
        .map((issue) => issue.message),
      steps: [
        `Download the file and open ${adapter.composerUrl}`,
        "Upload the file and wait for its preview to finish processing.",
        "Paste the caption below exactly — it is already within this platform's limit.",
        "Publish, then mark the destination published here so analytics can find it.",
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Optimisation
// ---------------------------------------------------------------------------

/**
 * Renders a shorter derivative for a platform the full cut overruns.
 *
 * The trim comes off the end of the EDL rather than being applied to the
 * finished file: cutting the last beats short keeps the hook and the substance
 * intact, where a blanket trim of the encoded file would sometimes drop the
 * call to action and always drop it silently.
 */
export async function optimizeForPlatform(input: {
  distributionId: string;
}): Promise<
  | { ok: true; renderJobId: string; targetSeconds: number }
  | { ok: false; reason: string }
> {
  const row = await prisma.distribution.findUniqueOrThrow({
    where: { id: input.distributionId },
  });

  if (row.fit !== DistributionFit.NEEDS_OPTIMIZATION) {
    return {
      ok: false,
      reason:
        row.fit === DistributionFit.READY
          ? "This cut already fits this platform."
          : "This cut fails something re-rendering cannot fix.",
    };
  }

  const adapter = getAdapter(row.platform);
  const max = adapter.constraints.maxDurationSeconds;
  if (max === null) {
    return { ok: false, reason: `${adapter.label} declares no duration limit.` };
  }
  const budget = Math.max(1, max - 0.5);

  const built = await buildEdlForVariant(row.variantId);
  const trimmed = trimEdlToBudget(built.edl, budget);
  if (trimmed === null) {
    return {
      ok: false,
      reason: `The cut cannot be brought under ${max}s without dropping every clip.`,
    };
  }

  const queued = await enqueueRender({
    variantId: row.variantId,
    options: {
      preserveSourceAudio: trimmed.preserveSourceAudio,
      normalizeAudio: trimmed.normalizeAudio,
      burnSubtitles: trimmed.burnSubtitles,
    },
    // The trimmed EDL is a different cut, so it hashes to its own key and its
    // own output file. The full-length original is untouched.
    edlOverride: trimmed,
  });

  await prisma.distribution.update({
    where: { id: row.id },
    data: {
      status: DistributionStatus.OPTIMIZING,
      optimizedFromAssetId: row.assetId,
      optimizeRenderJobId: queued.renderJobId,
    },
  });

  return { ok: true, renderJobId: queued.renderJobId, targetSeconds: budget };
}

/**
 * Shortens an EDL to a runtime budget.
 *
 * Whole clips are dropped from the end first; the last surviving clip is then
 * shortened to land on the budget. A clip trimmed below half a second is
 * dropped instead — a flash frame is not a shot.
 */
export function trimEdlToBudget<T extends { clips: Array<{ sourceStart: number; sourceEnd: number }> }>(
  edl: T,
  budgetSeconds: number,
): T | null {
  const clips: T["clips"] = [];
  let used = 0;

  for (const clip of edl.clips) {
    const length = clip.sourceEnd - clip.sourceStart;
    const remaining = budgetSeconds - used;
    if (remaining <= 0.5) break;

    if (length <= remaining) {
      clips.push(clip);
      used += length;
    } else {
      clips.push({ ...clip, sourceEnd: round3(clip.sourceStart + remaining) });
      used += remaining;
      break;
    }
  }

  if (clips.length === 0) return null;
  return { ...edl, clips };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Re-assesses a cut after its derivative render finished. */
export async function adoptOptimizedRender(renderJobId: string): Promise<boolean> {
  const job = await prisma.renderJob.findUnique({
    where: { id: renderJobId },
    select: { id: true, status: true, outputAssetId: true, variantId: true },
  });
  if (!job || job.status !== "SUCCEEDED" || !job.outputAssetId) return false;

  const rows = await prisma.distribution.findMany({
    where: { optimizeRenderJobId: renderJobId, status: DistributionStatus.OPTIMIZING },
  });
  if (rows.length === 0) return false;

  for (const row of rows) {
    // The derivative becomes this destination's cut, and is assessed on its own
    // terms — a trim that was still too long must not read as ready.
    await assessDistribution({
      assetId: job.outputAssetId,
      variantId: job.variantId,
      platforms: [row.platform],
    });
    await prisma.distribution.update({
      where: { id: row.id },
      data: { status: DistributionStatus.CANCELLED },
    });
  }

  return true;
}
