"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth/session";
import { retryPublishJob, sweepDueJobs } from "@/server/services/publish-service";
import { runPublishJob } from "@/server/automation/publish-runner";
import { disconnectAccount, verifyAccount } from "@/server/automation/connect-account";
import { queueJobId, queues } from "@/server/jobs/queues";
import { syncAnalytics } from "@/server/analytics/snapshots";
import { refreshRecommendations } from "@/server/learning/recommendations";
import { refreshTrends } from "@/server/learning/trends";
import { activateStrategy, generateStrategy } from "@/server/strategy";
import {
  createContentPlan,
  NoActiveStrategyError,
  skipBrief,
} from "@/server/content-director";
import {
  assessDistribution,
  dispatchAutomated,
  exportForManualUpload,
  optimizeForPlatform,
} from "@/server/distribution";
import {
  Platform,
  PublishPolicy,
  RecommendationStatus,
} from "@/generated/prisma/enums";
import type { ActionResult } from "./posts";

/**
 * Operational actions: publishing control, account connection, and manually
 * kicking the learning jobs.
 *
 * Anything long-running goes onto a queue rather than blocking the request. Where
 * Redis is unavailable the action says so plainly instead of appearing to work.
 */

function fail(error: unknown, fallback: string): ActionResult {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[action] ${fallback}:`, error);
  return { ok: false, message: message || fallback };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export async function retryJobAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const jobId = String(formData.get("jobId") ?? "");
    if (!jobId) return { ok: false, message: "Missing job." };

    await retryPublishJob(jobId, user.id);
    revalidatePath("/queue");
    revalidatePath("/");
    return { ok: true, message: "Re-queued. The worker will pick it up." };
  } catch (error) {
    return fail(error, "Could not retry the job");
  }
}

/**
 * Runs a publish job in this process, right now. Useful when the worker is not
 * running — the same runner, the same idempotency guarantees.
 */
export async function runJobNowAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const jobId = String(formData.get("jobId") ?? "");
    if (!jobId) return { ok: false, message: "Missing job." };

    const result = await runPublishJob(jobId);
    revalidatePath("/queue");
    revalidatePath("/");

    switch (result.outcome) {
      case "published":
        return {
          ok: true,
          message: result.verified
            ? `Published and confirmed on the platform${result.permalink ? ` — ${result.permalink}` : ""}.`
            : "Published, but the platform could not be re-read to confirm it. Check the account before retrying.",
        };
      case "scheduled":
        return {
          ok: true,
          message: `Handed to the platform's own scheduler for ${result.scheduledFor.toLocaleString()}.`,
        };
      case "skipped":
        return { ok: true, message: `Skipped: ${result.reason}` };
      case "blocked":
        return { ok: false, message: `Blocked: ${result.reason}` };
      case "failed":
        return {
          ok: false,
          message:
            `[${result.category} at ${result.stage}] ${result.error}` +
            (result.retryable
              ? " It will be retried."
              : " This will not be retried automatically."),
        };
    }
  } catch (error) {
    return fail(error, "Could not run the job");
  }
}

export async function sweepJobsAction(): Promise<ActionResult> {
  try {
    await requireUser();
    const requeued = await sweepDueJobs();
    revalidatePath("/queue");
    return {
      ok: true,
      message:
        requeued > 0
          ? `Re-queued ${requeued} due job(s).`
          : "Nothing was due; the queue matches the database.",
    };
  } catch (error) {
    return fail(error, "Sweep failed");
  }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

const addAccountSchema = z.object({
  projectId: z.string().min(1),
  platform: z.enum(Platform),
  handle: z.string().trim().min(2).max(60),
  displayName: z.string().trim().max(80).optional(),
});

export async function addAccountAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const parsed = addAccountSchema.safeParse({
      projectId: formData.get("projectId"),
      platform: formData.get("platform"),
      handle: formData.get("handle"),
      displayName: formData.get("displayName") || undefined,
    });
    if (!parsed.success) {
      return { ok: false, message: "Pick a platform and enter the account handle." };
    }

    const handle = parsed.data.handle.startsWith("@")
      ? parsed.data.handle
      : `@${parsed.data.handle}`;

    await prisma.socialAccount.create({
      data: {
        projectId: parsed.data.projectId,
        platform: parsed.data.platform,
        handle,
        displayName: parsed.data.displayName ?? null,
      },
    });

    revalidatePath("/accounts");
    return {
      ok: true,
      message: `Added ${handle}. Connect it to store a browser session.`,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return {
        ok: false,
        message: "That handle is already registered for this project and platform.",
      };
    }
    return fail(error, "Could not add the account");
  }
}

/**
 * Queues the interactive connect flow. It has to run on the worker: it opens a
 * visible browser window and waits up to five minutes for a person to finish
 * signing in, which a web request must not do.
 */
export async function connectAccountAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const socialAccountId = String(formData.get("socialAccountId") ?? "");
    if (!socialAccountId) return { ok: false, message: "Missing account." };

    try {
      await queues.accounts().add(
        "connect",
        { action: "connect", socialAccountId },
        { jobId: queueJobId("connect", socialAccountId, Date.now()) },
      );
    } catch {
      return {
        ok: false,
        message:
          "Could not reach Redis, so the connect job was not queued. Start the infrastructure with `npm run db:up` and the worker with `npm run worker`.",
      };
    }

    revalidatePath("/accounts");
    return {
      ok: true,
      message:
        "A browser window will open on the worker machine. Sign in there; the session is encrypted and stored when the platform reports you are signed in.",
    };
  } catch (error) {
    return fail(error, "Could not start the connect flow");
  }
}

export async function verifyAccountAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const socialAccountId = String(formData.get("socialAccountId") ?? "");
    if (!socialAccountId) return { ok: false, message: "Missing account." };

    const result = await verifyAccount(socialAccountId);
    revalidatePath("/accounts");
    return result.ok
      ? { ok: true, message: `Session is valid${result.handle ? ` (${result.handle})` : ""}.` }
      : { ok: false, message: result.reason };
  } catch (error) {
    return fail(error, "Could not verify the account");
  }
}

export async function disconnectAccountAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const socialAccountId = String(formData.get("socialAccountId") ?? "");
    if (!socialAccountId) return { ok: false, message: "Missing account." };

    await disconnectAccount(socialAccountId, user.id);
    revalidatePath("/accounts");
    return { ok: true, message: "Disconnected and the stored session was deleted." };
  } catch (error) {
    return fail(error, "Could not disconnect the account");
  }
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

export async function syncAnalyticsAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const projectId = String(formData.get("projectId") ?? "") || undefined;

    const summary = await syncAnalytics({ projectId });
    const projects = projectId
      ? [{ id: projectId }]
      : await prisma.project.findMany({ select: { id: true } });
    for (const project of projects) {
      await refreshRecommendations(project.id);
    }

    revalidatePath("/analytics");
    revalidatePath("/recommendations");
    revalidatePath("/");

    return {
      ok: true,
      message: `Checked ${summary.postsChecked} published destinations and captured ${summary.snapshotsCreated} new snapshot(s).${
        summary.errors.length > 0 ? ` ${summary.errors.length} error(s).` : ""
      }`,
    };
  } catch (error) {
    return fail(error, "Analytics sync failed");
  }
}

export async function refreshLearningAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const projectId = String(formData.get("projectId") ?? "") || undefined;
    const projects = projectId
      ? [{ id: projectId }]
      : await prisma.project.findMany({ select: { id: true } });

    let created = 0;
    let trends = 0;
    for (const project of projects) {
      trends += await refreshTrends(project.id);
      created += (await refreshRecommendations(project.id)).created;
    }

    revalidatePath("/recommendations");
    revalidatePath("/trends");
    return {
      ok: true,
      message: `Recomputed: ${created} recommendation(s), ${trends} trend observation(s).`,
    };
  } catch (error) {
    return fail(error, "Could not refresh the learning layer");
  }
}

const recommendationStatusSchema = z.object({
  recommendationId: z.string().min(1),
  status: z.enum([RecommendationStatus.ACCEPTED, RecommendationStatus.DISMISSED]),
});

export async function setRecommendationStatusAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireUser();
    const parsed = recommendationStatusSchema.safeParse({
      recommendationId: formData.get("recommendationId"),
      status: formData.get("status"),
    });
    if (!parsed.success) return { ok: false, message: "Unknown recommendation." };

    await prisma.recommendation.update({
      where: { id: parsed.data.recommendationId },
      data: { status: parsed.data.status },
    });

    revalidatePath("/recommendations");
    revalidatePath("/");
    return {
      ok: true,
      message:
        parsed.data.status === RecommendationStatus.ACCEPTED
          ? "Marked as accepted. It stays on the record with its evidence."
          : "Dismissed.",
    };
  } catch (error) {
    return fail(error, "Could not update the recommendation");
  }
}

// ---------------------------------------------------------------------------
// Project settings
// ---------------------------------------------------------------------------

const policySchema = z.object({
  projectId: z.string().min(1),
  publishPolicy: z.enum(PublishPolicy),
});

export async function setPublishPolicyAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireUser();
    const parsed = policySchema.safeParse({
      projectId: formData.get("projectId"),
      publishPolicy: formData.get("publishPolicy"),
    });
    if (!parsed.success) return { ok: false, message: "Unknown policy." };

    await prisma.project.update({
      where: { id: parsed.data.projectId },
      data: { publishPolicy: parsed.data.publishPolicy },
    });

    revalidatePath("/settings");
    revalidatePath("/projects");
    return {
      ok: true,
      message:
        parsed.data.publishPolicy === PublishPolicy.AUTO_PUBLISH
          ? "Set to auto publish. New posts will go out on schedule without review."
          : "Publishing policy updated.",
    };
  } catch (error) {
    return fail(error, "Could not update the policy");
  }
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export async function generateStrategyAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const projectId = String(formData.get("projectId") ?? "");
    if (!projectId) return { ok: false, message: "Pick a project first." };
    const activate = formData.get("activate") === "1";

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { workspaceId: true, slug: true },
    });

    const result = await generateStrategy({
      workspaceId: project.workspaceId,
      projectId,
      activate,
    });

    revalidatePath("/strategy");
    revalidatePath(`/projects/${project.slug}`);

    if (!result.ok) {
      // The draft is rejected, not silently downgraded: no StrategyVersion was
      // written, so the previous one is still the current one.
      return {
        ok: false,
        message: `Strategy rejected (${result.errorKind}): ${result.reason}`,
      };
    }
    return {
      ok: true,
      message: activate
        ? `Strategy v${result.version} is now active.`
        : `Strategy v${result.version} drafted. Review it, then activate.`,
    };
  } catch (error) {
    return fail(error, "Could not draft a strategy");
  }
}

export async function activateStrategyAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const strategyId = String(formData.get("strategyId") ?? "");
    if (!strategyId) return { ok: false, message: "Missing strategy." };
    await activateStrategy(strategyId);
    revalidatePath("/strategy");
    return { ok: true, message: "Strategy activated. The previous one is kept as superseded." };
  } catch (error) {
    return fail(error, "Could not activate the strategy");
  }
}

export async function createPlanAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const projectId = String(formData.get("projectId") ?? "");
    if (!projectId) return { ok: false, message: "Pick a project first." };
    const days = Number.parseInt(String(formData.get("days") ?? "14"), 10);

    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { workspaceId: true },
    });

    const result = await createContentPlan({
      workspaceId: project.workspaceId,
      projectId,
      days: Number.isFinite(days) && days > 0 ? Math.min(90, days) : 14,
      activate: true,
    });

    revalidatePath("/plan");
    revalidatePath("/calendar");

    if (!result.ok) {
      return { ok: false, message: `Plan rejected (${result.errorKind}): ${result.reason}` };
    }
    return {
      ok: true,
      message: `Plan v${result.version} is active with ${result.briefs} briefs.`,
    };
  } catch (error) {
    if (error instanceof NoActiveStrategyError) {
      return { ok: false, message: error.message };
    }
    return fail(error, "Could not build a plan");
  }
}

export async function skipBriefAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const briefId = String(formData.get("briefId") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (!briefId) return { ok: false, message: "Missing brief." };
    if (!reason) {
      // A skipped brief with no reason is a hole in the record; the whole point
      // of keeping it is knowing why it was not made.
      return { ok: false, message: "Say why it is being skipped — the reason is kept." };
    }
    await skipBrief({ briefId, reason });
    revalidatePath("/plan");
    return { ok: true, message: "Skipped. The brief and the reason are kept." };
  } catch (error) {
    return fail(error, "Could not skip the brief");
  }
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

export async function assessDistributionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireUser();
    const assetId = String(formData.get("assetId") ?? "");
    const variantId = String(formData.get("variantId") ?? "");
    if (!assetId || !variantId) return { ok: false, message: "Missing the cut." };

    const result = await assessDistribution({ assetId, variantId });
    revalidatePath("/distribution");
    revalidatePath(`/content/${assetId}`);

    if (result.targets.length === 0) {
      return {
        ok: false,
        message: "No accounts are connected for this project, so there is nowhere to send it.",
      };
    }
    const ready = result.targets.filter((target) => target.fit === "READY").length;
    return {
      ok: true,
      message: `Assessed for ${result.targets.length} platform${result.targets.length === 1 ? "" : "s"} — ${ready} ready.`,
    };
  } catch (error) {
    return fail(error, "Could not assess this cut");
  }
}

export async function dispatchDistributionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const assetId = String(formData.get("assetId") ?? "");
    const variantId = String(formData.get("variantId") ?? "");
    const platforms = formData.getAll("platform").map((value) => String(value));
    const whenRaw = String(formData.get("scheduledFor") ?? "").trim();

    if (!assetId || !variantId) return { ok: false, message: "Missing the cut." };
    const targets = platforms.filter((value): value is Platform =>
      Object.values(Platform).includes(value as Platform),
    );

    const result = await dispatchAutomated({
      assetId,
      variantId,
      platforms: targets,
      userId: user.id,
      scheduledFor: whenRaw ? new Date(whenRaw) : null,
    });

    revalidatePath("/distribution");
    revalidatePath("/queue");
    revalidatePath("/approvals");

    if (!result.ok) return { ok: false, message: result.reason };
    return {
      ok: true,
      message: `Dispatched to ${result.platforms.join(", ")}. It follows the normal approval and publishing path from here.`,
    };
  } catch (error) {
    return fail(error, "Could not dispatch this cut");
  }
}

export async function exportDistributionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const distributionId = String(formData.get("distributionId") ?? "");
    if (!distributionId) return { ok: false, message: "Missing the destination." };

    const result = await exportForManualUpload({ distributionId, userId: user.id });
    revalidatePath("/distribution");

    if (!result.ok) return { ok: false, message: result.reason };
    return {
      ok: true,
      message: `Ready for a manual upload to ${result.package.platformLabel}. Download the file and copy the caption below.`,
    };
  } catch (error) {
    return fail(error, "Could not prepare a manual export");
  }
}

export async function optimizeDistributionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireUser();
    const distributionId = String(formData.get("distributionId") ?? "");
    if (!distributionId) return { ok: false, message: "Missing the destination." };

    const result = await optimizeForPlatform({ distributionId });
    revalidatePath("/distribution");
    revalidatePath("/renders");

    if (!result.ok) return { ok: false, message: result.reason };
    return {
      ok: true,
      message: `Queued a ${result.targetSeconds.toFixed(0)}s cut for this platform. It appears here when the worker finishes.`,
    };
  } catch (error) {
    return fail(error, "Could not optimise this cut");
  }
}
