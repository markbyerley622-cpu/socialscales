import { env } from "@/env";
import { prisma } from "@/server/db";
import { absolutePath, storageKeys, writeBuffer } from "@/server/storage";
import { getAdapter } from "@/server/platforms/registry";
import {
  AdapterFailure,
  isRetryableCategory,
  type PublicationEvidence,
  type PublishOutcome,
  type StepLogger,
} from "@/server/platforms/types";
import { simulatePublish } from "./simulator";
import { hasStoredSession, markSessionExpired, withAccountSession } from "./browser";
import { recordActivitySafe, activityActions } from "@/server/activity/log";
import {
  AccountStatus,
  ActorType,
  AdapterMode,
  AttemptOutcome,
  FailureCategory,
  JobStatus,
  PostPlatformStatus,
  PostStatus,
  PublishStage,
} from "@/generated/prisma/enums";

/**
 * Executes one PublishJob.
 *
 * Invariants:
 *  - A destination already PUBLISHED is never published again. Retrying is safe.
 *  - Only one runner holds a job: the transition to RUNNING is a conditional
 *    update, so a second worker on the same id does nothing.
 *  - Live publishing requires a *verified* connected account. A stored session
 *    file is not sufficient, and a disconnected account blocks rather than fails.
 *  - Success is only recorded with the mode that produced it, so a row's
 *    provenance never has to be inferred from current configuration.
 */

export type RunResult =
  | { outcome: "skipped"; reason: string }
  | {
      outcome: "published";
      remotePostId: string | null;
      permalink: string | null;
      verified: boolean;
    }
  | { outcome: "scheduled"; scheduledFor: Date }
  | { outcome: "blocked"; reason: string }
  | {
      outcome: "failed";
      retryable: boolean;
      error: string;
      category: FailureCategory;
      stage: PublishStage;
    };

type StepEntry = { at: string; message: string; detail?: Record<string, unknown> };

/** Carries the screenshot taken at the exact point of failure. */
export class PublishFailure extends Error {
  constructor(
    message: string,
    readonly screenshotKey: string | null,
    readonly category: FailureCategory,
    readonly stage: PublishStage,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublishFailure";
  }
}

/**
 * Classifies an error the adapter did not classify itself.
 *
 * Adapters raise `AdapterFailure` with a category, and that is always preferred.
 * This is the fallback for everything else — Playwright timeouts, network
 * errors, bugs — and it deliberately defaults to UNKNOWN rather than guessing
 * something more specific.
 */
export function classifyError(error: unknown): {
  category: FailureCategory;
  stage: PublishStage | null;
} {
  if (error instanceof AdapterFailure) {
    return { category: error.category, stage: error.stage };
  }
  if (error instanceof PublishFailure) {
    return { category: error.category, stage: error.stage };
  }
  const message = error instanceof Error ? error.message : String(error);

  if (/media rejected|not accept this media/i.test(message)) {
    return { category: FailureCategory.MEDIA_REJECTED, stage: null };
  }
  if (/no stored browser session|reconnect the account|no longer valid/i.test(message)) {
    return { category: FailureCategory.AUTH_SESSION, stage: null };
  }
  if (/timed?\s?out|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|net::ERR/i.test(message)) {
    return { category: FailureCategory.TRANSIENT, stage: null };
  }
  return { category: FailureCategory.UNKNOWN, stage: null };
}

/**
 * Structured line for the worker log.
 *
 * Everything needed to trace one attempt end to end, and nothing that could leak
 * a credential: no cookies, no tokens, no storage state, and adapters strip query
 * strings from any URL they report.
 */
function observe(record: {
  jobId: string;
  postPlatformId: string;
  postId: string;
  attemptNo: number;
  account: string;
  platform: string;
  adapterMode: AdapterMode;
  stage: PublishStage;
  event: string;
  result?: string;
  category?: FailureCategory;
  detail?: Record<string, unknown>;
}): void {
  console.log(
    JSON.stringify({ at: new Date().toISOString(), scope: "publish", ...record }),
  );
}

export async function runPublishJob(jobId: string): Promise<RunResult> {
  const job = await prisma.publishJob.findUnique({
    where: { id: jobId },
    include: {
      postPlatform: {
        include: {
          account: true,
          post: { include: { project: true, asset: true, variant: true } },
        },
      },
    },
  });

  if (!job) return { outcome: "skipped", reason: `Job ${jobId} no longer exists.` };

  const target = job.postPlatform;
  const adapter = getAdapter(target.platform);

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

  const live = env.enableLivePublishing;
  const adapterMode = live ? AdapterMode.BROWSER_ASSISTED : AdapterMode.SIMULATED;

  // --- Pre-flight gates that block rather than fail -------------------------
  if (live) {
    const blocked = await preflightBlock(target.socialAccountId, adapter);
    if (blocked) {
      await blockJob(job.id, target.id, blocked);
      observe({
        jobId,
        postPlatformId: target.id,
        postId: target.postId,
        attemptNo: job.attempts,
        account: target.account.handle,
        platform: target.platform,
        adapterMode,
        stage: PublishStage.PREFLIGHT,
        event: "blocked",
        result: "blocked",
        category: FailureCategory.BLOCKED_DISCONNECTED,
        detail: { reason: blocked },
      });
      return { outcome: "blocked", reason: blocked };
    }
  }

  // --- Claim the job --------------------------------------------------------
  const claimed = await prisma.publishJob.updateMany({
    where: {
      id: jobId,
      status: {
        in: [JobStatus.PENDING, JobStatus.QUEUED, JobStatus.FAILED, JobStatus.BLOCKED],
      },
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
  let stage: PublishStage = PublishStage.QUEUED;

  const attempt = await prisma.publishAttempt.create({
    data: { jobId, attemptNo, steps: [], adapterMode, stageReached: stage },
  });

  const steps: StepEntry[] = [];
  const log: StepLogger = async (message, detail) => {
    steps.push({ at: new Date().toISOString(), message, detail });
    await prisma.publishAttempt.update({
      where: { id: attempt.id },
      data: { steps: steps as unknown as object[] },
    });
  };

  const trace = (event: string, extra: Partial<Parameters<typeof observe>[0]> = {}) =>
    observe({
      jobId,
      postPlatformId: target.id,
      postId: target.postId,
      attemptNo,
      account: target.account.handle,
      platform: target.platform,
      adapterMode,
      stage,
      event,
      ...extra,
    });

  const advance = async (next: PublishStage) => {
    stage = next;
    await prisma.publishAttempt.update({
      where: { id: attempt.id },
      data: { stageReached: next },
    });
    trace("stage");
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

  trace("started");
  await recordActivitySafe({
    action: activityActions.publishStarted,
    message: `Publishing "${target.post.variant.hook}" to ${target.platform}`,
    projectId: target.post.projectId,
    actorType: ActorType.WORKER,
    entityType: "PublishJob",
    entityId: jobId,
    metadata: { attemptNo, adapterMode },
  });

  try {
    await advance(PublishStage.PREFLIGHT);

    // --- Media validation --------------------------------------------------
    const verdict = adapter.validateMedia({
      mimeType: target.post.asset.mimeType,
      sizeBytes: target.post.asset.sizeBytes,
      durationSeconds: target.post.asset.durationSeconds,
      aspectRatio: target.post.asset.aspectRatio,
    });
    if (!verdict.ok) {
      throw new AdapterFailure(
        `Media rejected for ${adapter.label}: ` +
          verdict.issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => issue.message)
            .join(" "),
        FailureCategory.MEDIA_REJECTED,
        PublishStage.PREFLIGHT,
      );
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

    if (!live) {
      result = await simulatePublish({
        platform: target.platform,
        postPlatformId: target.id,
        caption,
        publishAt: nativeSchedule,
        log,
        attemptNo,
      });
      await advance(PublishStage.CONFIRMED);
    } else {
      await log("Live publishing enabled; opening the dedicated automation profile");
      result = await withAccountSession(
        target.socialAccountId,
        async (page) => {
          await advance(PublishStage.SESSION_RESTORED);
          await log("Session restored into the automation profile");

          const probe = await adapter.probeSignIn(page);
          if (probe.state !== "AUTHENTICATED") {
            await handleUnusableSession(target.socialAccountId, probe.state, probe.evidence);
            throw new AdapterFailure(
              probe.state === "CHALLENGE"
                ? `${adapter.label} is showing a verification challenge. Clear it by hand in the automation profile, then retry.`
                : `${adapter.label} session is not usable (${probe.state}). Reconnect the account.`,
              probe.state === "CHALLENGE"
                ? FailureCategory.HUMAN_ACTION_REQUIRED
                : FailureCategory.AUTH_SESSION,
              PublishStage.SESSION_RESTORED,
              { evidence: probe.evidence },
            );
          }

          await advance(PublishStage.AUTHENTICATED);
          await log("Account authenticated", {
            handle: probe.handle,
            evidence: probe.evidence,
          });

          try {
            const outcome = await adapter.publishViaBrowser({
              page,
              mediaPath: absolutePath(target.post.asset.storageKey),
              caption,
              hashtags: target.post.variant.hashtags,
              cta: target.post.variant.cta,
              publishAt: nativeSchedule,
              log,
            });
            await advance(PublishStage.SUBMITTED);
            return outcome;
          } catch (error) {
            // Photograph the page while the context is still open — the only
            // moment a useful screenshot exists.
            const { category, stage: failedStage } = classifyError(error);
            const key = storageKeys.attemptScreenshot(jobId, attemptNo);
            let screenshotKey: string | null = null;
            try {
              await writeBuffer(key, await page.screenshot({ fullPage: true }));
              screenshotKey = key;
              await log("Captured failure screenshot", { key });
            } catch (screenshotError) {
              await log("Could not capture a failure screenshot", {
                reason: String(screenshotError),
              });
            }
            throw new PublishFailure(
              error instanceof Error ? error.message : String(error),
              screenshotKey,
              category,
              failedStage ?? stage,
              { cause: error },
            );
          }
        },
        { headless: true, originUrl: adapter.sessionProbeUrl },
      );
      await advance(PublishStage.CONFIRMED);
    }

    // --- Reconciliation ----------------------------------------------------
    const verification: PublicationEvidence | null = result.verification;
    if (verification) await advance(PublishStage.VERIFIED);

    const publishedAt =
      result.status === "published"
        ? (verification?.publishedAt ?? new Date())
        : null;

    await prisma.$transaction([
      prisma.publishAttempt.update({
        where: { id: attempt.id },
        data: {
          outcome: AttemptOutcome.SUCCESS,
          finishedAt: new Date(),
          stageReached: stage,
          steps: steps as unknown as object[],
        },
      }),
      prisma.publishJob.update({
        where: { id: jobId },
        data: { status: JobStatus.SUCCEEDED, finishedAt: new Date(), lastError: null },
      }),
      prisma.postPlatform.update({
        where: { id: target.id },
        data: {
          status: PostPlatformStatus.PUBLISHED,
          remotePostId: result.remotePostId,
          permalink: result.permalink,
          publishedAt,
          adapterMode,
          platformAccountId: result.platformAccountId ?? target.account.externalId,
          verifiedAt: verification ? new Date() : null,
          verificationMethod: verification?.method ?? null,
          lastError: null,
        },
      }),
    ]);

    await syncPostStatus(target.postId);

    trace("finished", {
      result: result.status,
      detail: {
        remotePostId: result.remotePostId,
        verified: Boolean(verification),
        verificationMethod: verification?.method ?? null,
      },
    });

    await recordActivitySafe({
      action: activityActions.publishSucceeded,
      message:
        result.status === "scheduled"
          ? `Scheduled on ${adapter.label} for ${result.scheduledFor.toISOString()}`
          : verification
            ? `Published to ${adapter.label} and confirmed on the platform`
            : `Published to ${adapter.label} (unconfirmed — no platform evidence)`,
      projectId: target.post.projectId,
      actorType: ActorType.WORKER,
      entityType: "PostPlatform",
      entityId: target.id,
      metadata: {
        remotePostId: result.remotePostId,
        permalink: result.permalink,
        attemptNo,
        adapterMode,
        verificationMethod: verification?.method ?? null,
      },
    });

    if (result.status === "scheduled") {
      return { outcome: "scheduled", scheduledFor: result.scheduledFor };
    }
    return {
      outcome: "published",
      remotePostId: result.remotePostId,
      permalink: result.permalink,
      verified: Boolean(verification),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { category, stage: failedStage } = classifyError(error);
    if (failedStage) stage = failedStage;

    const exhausted = attemptNo >= job.maxAttempts;
    const retryable = isRetryableCategory(category) && !exhausted;

    await log(`Attempt ${attemptNo} failed: ${message}`, { category, stage });

    const screenshotKey =
      error instanceof PublishFailure ? error.screenshotKey : null;

    await prisma.$transaction([
      prisma.publishAttempt.update({
        where: { id: attempt.id },
        data: {
          outcome: retryable
            ? AttemptOutcome.RETRYABLE_FAILURE
            : AttemptOutcome.PERMANENT_FAILURE,
          failureCategory: category,
          stageReached: stage,
          finishedAt: new Date(),
          errorMessage: message,
          screenshotKey,
          steps: steps as unknown as object[],
        },
      }),
      prisma.publishJob.update({
        where: { id: jobId },
        data: {
          // Retryable stays FAILED so the sweeper and the operator can retry it;
          // exhausted goes to DEAD_LETTER so nothing keeps hammering it.
          status: retryable
            ? JobStatus.FAILED
            : exhausted
              ? JobStatus.DEAD_LETTER
              : JobStatus.FAILED,
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

    trace("finished", { result: "failed", category });

    await recordActivitySafe({
      action: activityActions.publishFailed,
      message: `${adapter.label} publish failed on attempt ${attemptNo} at ${stage} (${category}): ${message}`,
      projectId: target.post.projectId,
      actorType: ActorType.WORKER,
      entityType: "PublishJob",
      entityId: jobId,
      metadata: { attemptNo, category, stage, retryable, adapterMode },
    });

    return { outcome: "failed", retryable, error: message, category, stage };
  }
}

// ---------------------------------------------------------------------------

/**
 * Reasons a live publish must not even be attempted.
 *
 * These block rather than fail: the work is still valid, it simply cannot run
 * until a person reconnects the account. Returning a reason keeps the decision
 * in one place instead of scattered through the runner.
 */
async function preflightBlock(
  socialAccountId: string,
  adapter: ReturnType<typeof getAdapter>,
): Promise<string | null> {
  if (adapter.capabilities.publish === "UNSUPPORTED") {
    return `${adapter.label} does not support publishing through this system.`;
  }

  const account = await prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
    select: { status: true, handle: true },
  });
  if (!account) return "The destination account no longer exists.";

  if (account.status !== AccountStatus.CONNECTED) {
    return `${adapter.label} account ${account.handle} is ${account.status.toLowerCase().replace(/_/g, " ")}. Reconnect it before publishing.`;
  }
  if (!(await hasStoredSession(socialAccountId))) {
    return `${adapter.label} account ${account.handle} has no stored session. Reconnect it before publishing.`;
  }
  return null;
}

async function blockJob(
  jobId: string,
  postPlatformId: string,
  reason: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.publishJob.update({
      where: { id: jobId },
      data: { status: JobStatus.BLOCKED, lastError: reason, finishedAt: null },
    }),
    // PENDING, not FAILED: nothing was attempted, and reconnecting makes this
    // runnable again without any operator action on the post itself.
    prisma.postPlatform.update({
      where: { id: postPlatformId },
      data: { status: PostPlatformStatus.PENDING, lastError: reason },
    }),
  ]);
}

async function handleUnusableSession(
  socialAccountId: string,
  state: string,
  evidence: string,
): Promise<void> {
  await markSessionExpired(socialAccountId);
  await prisma.socialAccount.update({
    where: { id: socialAccountId },
    data: {
      status:
        state === "CHALLENGE" ? AccountStatus.CHALLENGE : AccountStatus.NEEDS_REAUTH,
      lastError: evidence,
      lastCheckedAt: new Date(),
    },
  });
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

/**
 * Re-reads the platform for destinations that published but were never
 * confirmed, and records the evidence. Lets a publication whose verification was
 * interrupted be reconciled later without republishing anything.
 */
export async function reconcileUnverified(
  socialAccountId: string,
  limit = 10,
): Promise<{ checked: number; verified: number }> {
  const targets = await prisma.postPlatform.findMany({
    where: {
      socialAccountId,
      status: PostPlatformStatus.PUBLISHED,
      verifiedAt: null,
      adapterMode: AdapterMode.BROWSER_ASSISTED,
    },
    orderBy: { publishedAt: "desc" },
    take: limit,
    include: { post: { include: { variant: true } } },
  });

  if (targets.length === 0) return { checked: 0, verified: 0 };

  const adapter = getAdapter(targets[0].platform);
  if (typeof adapter.verifyPublication !== "function") {
    return { checked: targets.length, verified: 0 };
  }

  let verified = 0;
  await withAccountSession(
    socialAccountId,
    async (page) => {
      for (const destination of targets) {
        const evidence = await adapter.verifyPublication!({
          page,
          remotePostId: destination.remotePostId,
          caption: destination.post.variant.caption,
          log: async () => {},
        });
        if (!evidence) continue;
        await prisma.postPlatform.update({
          where: { id: destination.id },
          data: {
            remotePostId: destination.remotePostId ?? evidence.remotePostId,
            permalink: destination.permalink ?? evidence.permalink,
            verifiedAt: new Date(),
            verificationMethod: evidence.method,
          },
        });
        verified += 1;
      }
    },
    { headless: true, originUrl: adapter.sessionProbeUrl },
  );

  return { checked: targets.length, verified };
}
