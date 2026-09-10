import { env } from "@/env";
import { prisma } from "@/server/db";
import { absolutePath, storageKeys, writeBuffer } from "@/server/storage";
import { getAdapter } from "@/server/platforms/registry";
import type { PublishOutcome, StepLogger } from "@/server/platforms/types";
import { simulatePublish } from "./simulator";
import { MissingSessionError, markSessionExpired, withAccountSession } from "./browser";
import { recordActivitySafe, activityActions } from "@/server/activity/log";
import {
  AccountStatus,
  ActorType,
  AttemptOutcome,
  JobStatus,
  PostPlatformStatus,
  PostStatus,
} from "@/generated/prisma/enums";

/**
 * Executes one PublishJob.
 *
 * Guarantees:
 *  - A job whose PostPlatform is already PUBLISHED is a no-op. Retrying is safe.
 *  - Only one runner can hold a job: the transition to RUNNING is a conditional
 *    update, so a second worker picking up the same id does nothing.
 *  - Every step is timestamped into PublishAttempt.steps and shown in the UI.
 *  - Failures are classified. Permanent failures do not burn retries.
 */

export type RunResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "published"; remotePostId: string | null; permalink: string | null }
  | { outcome: "scheduled"; scheduledFor: Date }
  | { outcome: "failed"; retryable: boolean; error: string };

type StepEntry = { at: string; message: string; detail?: Record<string, unknown> };

/** Carries the storage key of the screenshot taken at the point of failure. */
export class PublishFailure extends Error {
  constructor(
    message: string,
    readonly screenshotKey: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublishFailure";
  }
}

/** Errors that will never succeed on retry, so the job is failed immediately. */
function isPermanent(error: unknown): boolean {
  if (error instanceof MissingSessionError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no longer valid|Reconnect the account|not supported|layout has changed|publish this one by hand/i.test(
      message,
    ) || /media (?:validation|rejected)/i.test(message)
  );
}

export async function runPublishJob(jobId: string): Promise<RunResult> {
  const job = await prisma.publishJob.findUnique({
    where: { id: jobId },
    include: {
      postPlatform: {
        include: {
          account: true,
          post: {
            include: {
              project: true,
              asset: true,
              variant: true,
            },
          },
        },
      },
    },
  });

  if (!job) return { outcome: "skipped", reason: `Job ${jobId} no longer exists.` };

  const target = job.postPlatform;

  // --- Idempotency gate -----------------------------------------------------
  if (target.status === PostPlatformStatus.PUBLISHED) {
    return {
      outcome: "skipped",
      reason: "Already published; refusing to publish the same content twice.",
    };
  }
  if (job.status === JobStatus.SUCCEEDED) {
    return { outcome: "skipped", reason: "Job already succeeded." };
  }
  if (job.status === JobStatus.CANCELLED) {
    return { outcome: "skipped", reason: "Job was cancelled." };
  }

  // --- Claim the job --------------------------------------------------------
  const claimed = await prisma.publishJob.updateMany({
    where: {
      id: jobId,
      status: { in: [JobStatus.PENDING, JobStatus.QUEUED, JobStatus.FAILED] },
    },
    data: { status: JobStatus.RUNNING, startedAt: new Date() },
  });
  if (claimed.count === 0) {
    return {
      outcome: "skipped",
      reason: `Job is already ${job.status}; another worker holds it.`,
    };
  }

  const attemptNo = job.attempts + 1;
  const attempt = await prisma.publishAttempt.create({
    data: { jobId, attemptNo, steps: [] },
  });

  const steps: StepEntry[] = [];
  const log: StepLogger = async (message, detail) => {
    steps.push({ at: new Date().toISOString(), message, detail });
    await prisma.publishAttempt.update({
      where: { id: attempt.id },
      data: { steps: steps as unknown as object[] },
    });
  };

  await prisma.$transaction([
    prisma.publishJob.update({ where: { id: jobId }, data: { attempts: attemptNo } }),
    prisma.postPlatform.update({
      where: { id: target.id },
      data: { status: PostPlatformStatus.UPLOADING },
    }),
    prisma.post.update({
      where: { id: target.postId },
      data: { status: PostStatus.UPLOADING },
    }),
  ]);

  await recordActivitySafe({
    action: activityActions.publishStarted,
    message: `Publishing "${target.post.variant.hook}" to ${target.platform}`,
    projectId: target.post.projectId,
    actorType: ActorType.WORKER,
    entityType: "PublishJob",
    entityId: jobId,
    metadata: { attemptNo },
  });

  const adapter = getAdapter(target.platform);

  try {
    // --- Pre-flight validation ---------------------------------------------
    const verdict = adapter.validateMedia({
      mimeType: target.post.asset.mimeType,
      sizeBytes: target.post.asset.sizeBytes,
      durationSeconds: target.post.asset.durationSeconds,
      aspectRatio: target.post.asset.aspectRatio,
    });
    if (!verdict.ok) {
      const errors = verdict.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .join(" ");
      throw new Error(`Media rejected for ${adapter.label}: ${errors}`);
    }
    for (const warning of verdict.issues.filter((i) => i.severity === "warning")) {
      await log(`Warning: ${warning.message}`);
    }

    const caption = adapter.composeCaption({
      caption: target.post.variant.caption,
      hashtags: target.post.variant.hashtags,
      cta: target.post.variant.cta,
    });

    // Only hand a future time to the platform when it can hold it itself.
    const nativeSchedule =
      adapter.capabilities.nativeSchedule !== "UNSUPPORTED" &&
      target.post.scheduledFor !== null &&
      target.post.scheduledFor.getTime() > Date.now() + 60_000
        ? target.post.scheduledFor
        : null;

    let result: PublishOutcome;

    if (!env.enableLivePublishing) {
      result = await simulatePublish({
        platform: target.platform,
        postPlatformId: target.id,
        caption,
        publishAt: nativeSchedule,
        log,
        attemptNo,
      });
    } else {
      await log("Live publishing enabled; launching browser");
      result = await withAccountSession(
        target.socialAccountId,
        async (page) => {
          await log("Restored stored session");
          const probe = await adapter.probeSignIn(page);
          if (!probe.signedIn) {
            await markSessionExpired(target.socialAccountId);
            await prisma.socialAccount.update({
              where: { id: target.socialAccountId },
              data: {
                status: AccountStatus.NEEDS_REAUTH,
                lastError: "Stored session is no longer signed in.",
              },
            });
            throw new Error(
              `${adapter.label} session is no longer valid. Reconnect the account.`,
            );
          }
          await log("Account authenticated", { handle: probe.handle });

          try {
            return await adapter.publishViaBrowser({
              page,
              mediaPath: absolutePath(target.post.asset.storageKey),
              caption,
              hashtags: target.post.variant.hashtags,
              cta: target.post.variant.cta,
              publishAt: nativeSchedule,
              log,
            });
          } catch (error) {
            // Capture the page while the context is still open — this is the
            // only moment a useful screenshot exists.
            const key = storageKeys.attemptScreenshot(jobId, attemptNo);
            try {
              const shot = await page.screenshot({ fullPage: true });
              await writeBuffer(key, shot);
              await log("Captured failure screenshot", { key });
              throw new PublishFailure(
                error instanceof Error ? error.message : String(error),
                key,
                { cause: error },
              );
            } catch (screenshotError) {
              if (screenshotError instanceof PublishFailure) throw screenshotError;
              await log("Could not capture a failure screenshot", {
                reason: String(screenshotError),
              });
              throw error;
            }
          }
        },
        { headless: true },
      );
    }

    // --- Success -----------------------------------------------------------
    const publishedAt = result.status === "published" ? new Date() : null;

    await prisma.$transaction([
      prisma.publishAttempt.update({
        where: { id: attempt.id },
        data: {
          outcome: AttemptOutcome.SUCCESS,
          finishedAt: new Date(),
          steps: steps as unknown as object[],
        },
      }),
      prisma.publishJob.update({
        where: { id: jobId },
        data: {
          status: JobStatus.SUCCEEDED,
          finishedAt: new Date(),
          lastError: null,
        },
      }),
      prisma.postPlatform.update({
        where: { id: target.id },
        data: {
          status: PostPlatformStatus.PUBLISHED,
          remotePostId: result.remotePostId,
          permalink: result.permalink,
          publishedAt,
          lastError: null,
        },
      }),
    ]);

    await syncPostStatus(target.postId);

    await recordActivitySafe({
      action: activityActions.publishSucceeded,
      message:
        result.status === "scheduled"
          ? `Scheduled on ${adapter.label} for ${result.scheduledFor.toISOString()}`
          : `Published to ${adapter.label}`,
      projectId: target.post.projectId,
      actorType: ActorType.WORKER,
      entityType: "PostPlatform",
      entityId: target.id,
      metadata: { remotePostId: result.remotePostId, attemptNo },
    });

    if (result.status === "scheduled") {
      return { outcome: "scheduled", scheduledFor: result.scheduledFor };
    }
    return {
      outcome: "published",
      remotePostId: result.remotePostId,
      permalink: result.permalink,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const permanent = isPermanent(error);
    const exhausted = attemptNo >= job.maxAttempts;
    const retryable = !permanent && !exhausted;

    await log(`Attempt ${attemptNo} failed: ${message}`);

    // Set when the adapter failed with a live page we could photograph.
    const screenshotKey =
      error instanceof PublishFailure ? error.screenshotKey : null;

    await prisma.$transaction([
      prisma.publishAttempt.update({
        where: { id: attempt.id },
        data: {
          outcome: permanent
            ? AttemptOutcome.PERMANENT_FAILURE
            : AttemptOutcome.RETRYABLE_FAILURE,
          finishedAt: new Date(),
          errorMessage: message,
          screenshotKey,
          steps: steps as unknown as object[],
        },
      }),
      prisma.publishJob.update({
        where: { id: jobId },
        data: {
          status: retryable
            ? JobStatus.FAILED
            : permanent
              ? JobStatus.FAILED
              : JobStatus.DEAD_LETTER,
          finishedAt: retryable ? null : new Date(),
          lastError: message,
        },
      }),
      prisma.postPlatform.update({
        where: { id: target.id },
        data: { status: PostPlatformStatus.FAILED, lastError: message },
      }),
    ]);

    await syncPostStatus(target.postId);

    await recordActivitySafe({
      action: activityActions.publishFailed,
      message: `${adapter.label} publish failed on attempt ${attemptNo}: ${message}`,
      projectId: target.post.projectId,
      actorType: ActorType.WORKER,
      entityType: "PublishJob",
      entityId: jobId,
      metadata: { attemptNo, permanent, retryable },
    });

    return { outcome: "failed", retryable, error: message };
  }
}

/**
 * A post is only PUBLISHED once every target has published. Any failed target
 * makes the post FAILED, so the dashboard never shows a green post with a broken
 * platform underneath it.
 */
export async function syncPostStatus(postId: string): Promise<void> {
  const targets = await prisma.postPlatform.findMany({
    where: { postId },
    select: { status: true },
  });
  if (targets.length === 0) return;

  const has = (status: PostPlatformStatus) =>
    targets.some((target) => target.status === status);

  let status: PostStatus;
  if (has(PostPlatformStatus.FAILED)) status = PostStatus.FAILED;
  else if (targets.every((t) => t.status === PostPlatformStatus.PUBLISHED))
    status = PostStatus.PUBLISHED;
  else if (has(PostPlatformStatus.UPLOADING)) status = PostStatus.UPLOADING;
  else status = PostStatus.SCHEDULED;

  await prisma.post.update({ where: { id: postId }, data: { status } });
}
