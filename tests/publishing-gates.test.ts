import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { createPost, approvePost } from "@/server/services/post-service";
import { runPublishJob } from "@/server/automation/publish-runner";
import { unblockAccountJobs } from "@/server/services/publish-service";
import { disconnectAccount } from "@/server/automation/connect-account";
import {
  cleanupTestStorage,
  createAssetFixture,
  createOperator,
  createProjectFixture,
  createVariantFixture,
  migrateTestSchema,
  resetDatabase,
} from "./helpers";
import {
  AccountStatus,
  AdapterMode,
  FailureCategory,
  JobStatus,
  Platform,
  PlatformSessionStatus,
  PostPlatformStatus,
} from "@/generated/prisma/enums";

/**
 * Gates around live publishing, exercised against the real database.
 *
 * These run with ENABLE_LIVE_PUBLISHING off, so the publish path itself is the
 * simulator — but the gates under test (connection checks, blocking, idempotency,
 * provenance recording) are the same code the live path runs, and are exactly
 * the parts that must not be taken on trust.
 */

beforeAll(async () => {
  await migrateTestSchema();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await resetDatabase();
  await cleanupTestStorage();
  await prisma.$disconnect();
});

/** An approved, queued post with exactly one TikTok destination. */
async function queuedTikTokPost(seed: number) {
  const project = await createProjectFixture({
    slug: `gate-${seed}`,
    platforms: [Platform.TIKTOK],
  });
  const operator = await createOperator(`gate-${seed}@test.local`);
  const asset = await createAssetFixture({ projectId: project.id, seed });
  const variant = await createVariantFixture({ assetId: asset.id });

  const { postId } = await createPost({
    projectId: project.id,
    assetId: asset.id,
    variantId: variant.id,
    socialAccountIds: [project.accounts[0].id],
    scheduledFor: null,
    userId: operator.id,
  });
  await approvePost({ postId, userId: operator.id, scheduledFor: new Date() });

  const job = await prisma.publishJob.findFirstOrThrow();
  return { project, operator, postId, job, accountId: project.accounts[0].id };
}

/** Gives an account the stored session a live publish requires. */
async function giveStoredSession(socialAccountId: string) {
  await prisma.platformSession.create({
    data: {
      socialAccountId,
      status: PlatformSessionStatus.ACTIVE,
      cipherText: "x",
      iv: "y",
      authTag: "z",
      profileKey: `browser-profiles/${socialAccountId}`,
    },
  });
}

// ---------------------------------------------------------------------------

describe("publication provenance", () => {
  it("records the mode that actually produced the publication", async () => {
    const { job } = await queuedTikTokPost(1);

    const result = await runPublishJob(job.id);
    expect(result.outcome).toBe("published");

    const target = await prisma.postPlatform.findFirstOrThrow();
    // Simulation mode must be recorded on the row, not inferred later from
    // whatever ENABLE_LIVE_PUBLISHING happens to be set to.
    expect(target.adapterMode).toBe(AdapterMode.SIMULATED);

    const attempt = await prisma.publishAttempt.findFirstOrThrow();
    expect(attempt.adapterMode).toBe(AdapterMode.SIMULATED);
    expect(attempt.stageReached).toBe("CONFIRMED");
    expect(attempt.failureCategory).toBeNull();
  });

  it("leaves a simulated publication explicitly unverified", async () => {
    const { job } = await queuedTikTokPost(2);
    await runPublishJob(job.id);

    const target = await prisma.postPlatform.findFirstOrThrow();
    // The simulator produces no platform evidence, so nothing may claim it did.
    expect(target.verifiedAt).toBeNull();
    expect(target.verificationMethod).toBeNull();
  });
});

describe("idempotency", () => {
  it("a second execution of the same job publishes nothing further", async () => {
    const { job } = await queuedTikTokPost(3);

    const first = await runPublishJob(job.id);
    expect(first.outcome).toBe("published");

    const second = await runPublishJob(job.id);
    expect(second.outcome).toBe("skipped");

    expect(await prisma.publishAttempt.count({ where: { jobId: job.id } })).toBe(1);
  });

  it("concurrent duplicate delivery produces exactly one attempt", async () => {
    const { job } = await queuedTikTokPost(4);

    // Two workers handed the same job id at the same moment.
    const [a, b] = await Promise.all([
      runPublishJob(job.id),
      runPublishJob(job.id),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["published", "skipped"]);
    expect(await prisma.publishAttempt.count({ where: { jobId: job.id } })).toBe(1);
  });

  it("survives a worker restart mid-flight without republishing", async () => {
    const { job } = await queuedTikTokPost(5);

    // Simulate a worker that died after claiming the job: the row is left
    // RUNNING with an open attempt and nothing finished it.
    await prisma.publishJob.update({
      where: { id: job.id },
      data: { status: JobStatus.RUNNING, attempts: 1, startedAt: new Date() },
    });
    await prisma.publishAttempt.create({
      data: { jobId: job.id, attemptNo: 1, steps: [], stageReached: "SUBMITTED" },
    });

    // A restarted worker re-delivered the same job must not claim it.
    const afterRestart = await runPublishJob(job.id);
    expect(afterRestart.outcome).toBe("skipped");
    expect(await prisma.publishAttempt.count({ where: { jobId: job.id } })).toBe(1);
  });

  it("a manual retry after success is refused", async () => {
    const { job } = await queuedTikTokPost(6);
    await runPublishJob(job.id);

    const { retryPublishJob } = await import("@/server/services/publish-service");
    await expect(retryPublishJob(job.id, null)).rejects.toThrow(/already published/i);
  });

  it("the unique idempotency key still rejects a second job row", async () => {
    const { job } = await queuedTikTokPost(7);

    await expect(
      prisma.publishJob.create({
        data: {
          postPlatformId: job.postPlatformId,
          idempotencyKey: job.idempotencyKey,
          runAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});

describe("disconnect blocks live publishing", () => {
  // These assert the live gate directly rather than through the env flag, so the
  // behaviour is covered without needing a real account.
  const withLive = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = process.env.ENABLE_LIVE_PUBLISHING;
    process.env.ENABLE_LIVE_PUBLISHING = "1";
    // env is read at import time, so patch the resolved object for the duration.
    const { env } = await import("@/env");
    const original = env.enableLivePublishing;
    Object.defineProperty(env, "enableLivePublishing", {
      value: true,
      configurable: true,
    });
    try {
      return await work();
    } finally {
      Object.defineProperty(env, "enableLivePublishing", {
        value: original,
        configurable: true,
      });
      if (previous === undefined) delete process.env.ENABLE_LIVE_PUBLISHING;
      else process.env.ENABLE_LIVE_PUBLISHING = previous;
    }
  };

  it("blocks rather than fails when the account is disconnected", async () => {
    const { job, accountId } = await queuedTikTokPost(10);
    await prisma.socialAccount.update({
      where: { id: accountId },
      data: { status: AccountStatus.DISCONNECTED },
    });

    const result = await withLive(() => runPublishJob(job.id));
    expect(result.outcome).toBe("blocked");

    const after = await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe(JobStatus.BLOCKED);
    // Nothing was attempted, so no retry budget may be consumed.
    expect(after.attempts).toBe(0);
    expect(await prisma.publishAttempt.count({ where: { jobId: job.id } })).toBe(0);

    const target = await prisma.postPlatform.findUniqueOrThrow({
      where: { id: job.postPlatformId },
    });
    // PENDING, not FAILED: reconnecting makes this runnable with no other action.
    expect(target.status).toBe(PostPlatformStatus.PENDING);
    expect(target.publishedAt).toBeNull();
  });

  it("blocks when the account is connected but has no stored session", async () => {
    const { job, accountId } = await queuedTikTokPost(11);
    await prisma.socialAccount.update({
      where: { id: accountId },
      data: { status: AccountStatus.CONNECTED },
    });
    // Fixture accounts are CONNECTED but carry no PlatformSession row.

    const result = await withLive(() => runPublishJob(job.id));
    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.reason).toMatch(/no stored session/i);
    }
  });

  it("blocks an account showing a challenge", async () => {
    const { job, accountId } = await queuedTikTokPost(12);
    await giveStoredSession(accountId);
    await prisma.socialAccount.update({
      where: { id: accountId },
      data: { status: AccountStatus.CHALLENGE },
    });

    const result = await withLive(() => runPublishJob(job.id));
    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.reason).toMatch(/challenge/i);
    }
  });

  it("disconnecting deletes the stored session outright", async () => {
    const { accountId } = await queuedTikTokPost(13);
    await giveStoredSession(accountId);

    await disconnectAccount(accountId, null);

    const account = await prisma.socialAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    expect(account.status).toBe(AccountStatus.DISCONNECTED);
    // Stale credentials must not linger where something could treat them as live.
    expect(
      await prisma.platformSession.count({ where: { socialAccountId: accountId } }),
    ).toBe(0);
  });

  it("does not block a published destination back into the queue", async () => {
    const { job, accountId } = await queuedTikTokPost(14);
    await runPublishJob(job.id);

    await prisma.socialAccount.update({
      where: { id: accountId },
      data: { status: AccountStatus.DISCONNECTED },
    });

    // Already published: the idempotency gate wins over the connection gate.
    const result = await withLive(() => runPublishJob(job.id));
    expect(result.outcome).toBe("skipped");
  });
});

describe("unblocking on reconnect", () => {
  it("returns blocked jobs to the queue without touching published ones", async () => {
    const { job, accountId } = await queuedTikTokPost(20);

    await prisma.publishJob.update({
      where: { id: job.id },
      data: { status: JobStatus.BLOCKED, lastError: "account disconnected" },
    });
    await prisma.postPlatform.update({
      where: { id: job.postPlatformId },
      data: { status: PostPlatformStatus.PENDING },
    });

    const released = await unblockAccountJobs(accountId);
    expect(released).toBe(1);

    const after = await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe(JobStatus.QUEUED);
    expect(after.lastError).toBeNull();
  });

  it("leaves an already published destination alone", async () => {
    const { job, accountId } = await queuedTikTokPost(21);
    await runPublishJob(job.id);

    const released = await unblockAccountJobs(accountId);
    expect(released).toBe(0);

    const after = await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe(JobStatus.SUCCEEDED);
  });
});

describe("failure and retry", () => {
  it("records the category and stage, and does not duplicate on retry", async () => {
    const { job } = await queuedTikTokPost(30);

    // A controlled, safe failure: media the platform will not accept.
    await prisma.contentAsset.updateMany({
      data: { durationSeconds: 4_000 },
    });

    const failed = await runPublishJob(job.id);
    expect(failed.outcome).toBe("failed");
    if (failed.outcome === "failed") {
      expect(failed.category).toBe(FailureCategory.MEDIA_REJECTED);
      expect(failed.stage).toBe("PREFLIGHT");
      // Retrying a media rejection can never succeed, so it must not be retried.
      expect(failed.retryable).toBe(false);
    }

    const attempt = await prisma.publishAttempt.findFirstOrThrow({
      where: { jobId: job.id },
    });
    expect(attempt.failureCategory).toBe(FailureCategory.MEDIA_REJECTED);
    expect(attempt.errorMessage).toMatch(/Media rejected/);

    // Fix the cause, retry, and confirm exactly one publication results.
    await prisma.contentAsset.updateMany({ data: { durationSeconds: 24 } });
    await prisma.publishJob.update({
      where: { id: job.id },
      data: { status: JobStatus.FAILED, maxAttempts: 5 },
    });

    const retried = await runPublishJob(job.id);
    expect(retried.outcome).toBe("published");

    const published = await prisma.postPlatform.count({
      where: { status: PostPlatformStatus.PUBLISHED },
    });
    expect(published).toBe(1);
    expect(await prisma.publishAttempt.count({ where: { jobId: job.id } })).toBe(2);
  });

  it("classifies a transient failure, retries it, and publishes exactly once", async () => {
    const { job } = await queuedTikTokPost(32);

    // Force the simulator to fail the first attempt. Previously this path was
    // only reachable by chance, which is what made the suite flaky.
    const { env } = await import("@/env");
    const original = env.simulatedFailureRate;
    Object.defineProperty(env, "simulatedFailureRate", {
      value: 1,
      configurable: true,
    });

    let failed;
    try {
      failed = await runPublishJob(job.id);
    } finally {
      Object.defineProperty(env, "simulatedFailureRate", {
        value: original,
        configurable: true,
      });
    }

    expect(failed.outcome).toBe("failed");
    if (failed.outcome === "failed") {
      // A simulated composer timeout reads as transient, so it may be retried.
      expect(failed.category).toBe(FailureCategory.TRANSIENT);
      expect(failed.retryable).toBe(true);
    }

    const firstAttempt = await prisma.publishAttempt.findFirstOrThrow({
      where: { jobId: job.id, attemptNo: 1 },
    });
    expect(firstAttempt.failureCategory).toBe(FailureCategory.TRANSIENT);

    const afterFailure = await prisma.publishJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(afterFailure.status).toBe(JobStatus.FAILED);
    // Still retryable, so no finish time is recorded.
    expect(afterFailure.finishedAt).toBeNull();

    // Second attempt succeeds (the simulator only fails attempt 1).
    const retried = await runPublishJob(job.id);
    expect(retried.outcome).toBe("published");

    expect(
      await prisma.postPlatform.count({ where: { status: PostPlatformStatus.PUBLISHED } }),
    ).toBe(1);
    expect(await prisma.publishAttempt.count({ where: { jobId: job.id } })).toBe(2);
  });

  it("stops retrying once the attempt budget is spent", async () => {
    const { job } = await queuedTikTokPost(31);
    await prisma.contentAsset.updateMany({ data: { durationSeconds: 4_000 } });
    await prisma.publishJob.update({
      where: { id: job.id },
      data: { maxAttempts: 1 },
    });

    const result = await runPublishJob(job.id);
    expect(result.outcome).toBe("failed");

    const after = await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    expect([JobStatus.FAILED, JobStatus.DEAD_LETTER]).toContain(after.status);
    expect(after.finishedAt).not.toBeNull();
  });
});
