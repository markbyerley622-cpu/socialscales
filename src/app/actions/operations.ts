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
        return { ok: true, message: "Published." };
      case "scheduled":
        return {
          ok: true,
          message: `Handed to the platform's own scheduler for ${result.scheduledFor.toLocaleString()}.`,
        };
      case "skipped":
        return { ok: true, message: `Skipped: ${result.reason}` };
      case "failed":
        return {
          ok: false,
          message: `${result.error}${result.retryable ? " It will be retried." : " This will not be retried automatically."}`,
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
