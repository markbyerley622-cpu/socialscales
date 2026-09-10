import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  analyzeAsset,
  createAsset,
  DuplicateAssetError,
} from "@/server/services/content-service";
import {
  approvePost,
  createPost,
  NotApprovedError,
  rejectPost,
  schedulePost,
  unschedulePost,
} from "@/server/services/post-service";
import { runPublishJob } from "@/server/automation/publish-runner";
import { cancelPublish, enqueuePublish } from "@/server/services/publish-service";
import { syncAnalytics } from "@/server/analytics/snapshots";
import { loadPostFacts } from "@/server/analytics/aggregate";
import { refreshRecommendations } from "@/server/learning/recommendations";
import {
  authenticate,
  pruneSessions,
  resolveSession,
} from "@/server/auth/session";
import {
  cleanupTestStorage,
  createAssetFixture,
  createOperator,
  createProjectFixture,
  createVariantFixture,
  migrateTestSchema,
  resetDatabase,
  sampleVideo,
} from "./helpers";
import {
  ApprovalState,
  JobStatus,
  MetricSource,
  Platform,
  PostPlatformStatus,
  PostStatus,
  PublishPolicy,
} from "@/generated/prisma/enums";

/**
 * Integration tests against the real database.
 *
 * The publish path runs the simulator, which is exactly what the worker executes
 * with ENABLE_LIVE_PUBLISHING off — so the queue, claim, retry, idempotency and
 * status-transition logic under test here is the production logic, not a stand-in.
 *
 * No Redis, no browser and no social account is required.
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

// ---------------------------------------------------------------------------

describe("upload and analysis", () => {
  it("stores an asset with the facts read out of its own bytes", async () => {
    const project = await createProjectFixture();
    const operator = await createOperator();

    const { asset } = await createAsset({
      projectId: project.id,
      uploaderId: operator.id,
      filename: "creator-screen-recording-demo.mp4",
      declaredMime: "video/mp4",
      data: sampleVideo({ durationSeconds: 31, seed: 1 }),
    });

    expect(asset.durationSeconds).toBeCloseTo(31, 1);
    expect(asset.aspectRatio).toBe("9:16");
    expect(asset.hasAudio).toBe(true);
    expect(asset.checksum).toHaveLength(64);
    expect(asset.title).toBe("creator screen recording demo");
  });

  it("refuses the same file twice in one project", async () => {
    const project = await createProjectFixture();
    const data = sampleVideo({ seed: 2 });

    await createAsset({
      projectId: project.id,
      uploaderId: null,
      filename: "first.mp4",
      data,
    });

    // A different filename must not defeat the content fingerprint.
    await expect(
      createAsset({
        projectId: project.id,
        uploaderId: null,
        filename: "renamed-copy.mp4",
        data,
      }),
    ).rejects.toBeInstanceOf(DuplicateAssetError);
  });

  it("allows the same file in a different project", async () => {
    const a = await createProjectFixture({ slug: "dup-a" });
    const b = await createProjectFixture({ slug: "dup-b" });
    const data = sampleVideo({ seed: 3 });

    await createAsset({ projectId: a.id, uploaderId: null, filename: "x.mp4", data });
    await expect(
      createAsset({ projectId: b.id, uploaderId: null, filename: "x.mp4", data }),
    ).resolves.toBeTruthy();
  });

  it("writes an analysis and draft variants, and records the activity", async () => {
    const project = await createProjectFixture();
    const operator = await createOperator();
    const asset = await createAssetFixture({
      projectId: project.id,
      uploaderId: operator.id,
      filename: "creator-tutorial-setup.mp4",
      seed: 4,
    });

    const result = await analyzeAsset({ assetId: asset.id, userId: operator.id });

    expect(result.variantIds.length).toBeGreaterThanOrEqual(3);
    expect(result.format).toBe("TUTORIAL");

    const variants = await prisma.contentVariant.findMany({
      where: { assetId: asset.id },
    });
    expect(variants).toHaveLength(result.variantIds.length);
    // Exactly one control on the first analysis run.
    expect(variants.filter((variant) => variant.isControl)).toHaveLength(1);
    for (const variant of variants) {
      expect(variant.scorecard).toBeTruthy();
    }

    const refreshed = await prisma.contentAsset.findUniqueOrThrow({
      where: { id: asset.id },
    });
    expect(refreshed.status).toBe("ANALYZED");

    const activity = await prisma.activityLog.findMany({
      where: { entityId: asset.id },
    });
    expect(activity.map((entry) => entry.action)).toContain("asset.analyzed");
  });

  it("appends on re-analysis rather than overwriting edited copy", async () => {
    const project = await createProjectFixture();
    const asset = await createAssetFixture({ projectId: project.id, seed: 5 });

    await analyzeAsset({ assetId: asset.id, userId: null });
    const first = await prisma.contentVariant.count({ where: { assetId: asset.id } });

    await analyzeAsset({ assetId: asset.id, userId: null });
    const second = await prisma.contentVariant.count({ where: { assetId: asset.id } });

    expect(second).toBeGreaterThan(first);
    expect(
      await prisma.aIAnalysis.count({ where: { assetId: asset.id } }),
    ).toBe(2);
    // Still exactly one control: the second run must not create another.
    expect(
      await prisma.contentVariant.count({ where: { assetId: asset.id, isControl: true } }),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("post creation and approval", () => {
  it("creates a post awaiting approval under the default policy", async () => {
    const project = await createProjectFixture();
    const asset = await createAssetFixture({ projectId: project.id, seed: 10 });
    const variant = await createVariantFixture({ assetId: asset.id });

    const result = await createPost({
      projectId: project.id,
      assetId: asset.id,
      variantId: variant.id,
      socialAccountIds: [project.accounts[0].id],
      scheduledFor: new Date(Date.now() + 60_000),
      userId: null,
    });

    expect(result.autoApproved).toBe(false);
    expect(result.approvalState).toBe(ApprovalState.PENDING);
    expect(result.status).toBe(PostStatus.READY);

    // Nothing may be queued before approval.
    expect(await prisma.publishJob.count()).toBe(0);
  });

  it("auto-approves and queues under AUTO_PUBLISH", async () => {
    const project = await createProjectFixture({
      slug: "auto-publish",
      publishPolicy: PublishPolicy.AUTO_PUBLISH,
    });
    const asset = await createAssetFixture({ projectId: project.id, seed: 11 });
    const variant = await createVariantFixture({ assetId: asset.id });

    const result = await createPost({
      projectId: project.id,
      assetId: asset.id,
      variantId: variant.id,
      socialAccountIds: [project.accounts[0].id],
      scheduledFor: new Date(Date.now() + 60_000),
      userId: null,
    });

    expect(result.autoApproved).toBe(true);
    expect(await prisma.publishJob.count()).toBe(1);
  });

  it("refuses to schedule a post that has not been approved", async () => {
    const project = await createProjectFixture();
    const asset = await createAssetFixture({ projectId: project.id, seed: 12 });
    const variant = await createVariantFixture({ assetId: asset.id });

    const { postId } = await createPost({
      projectId: project.id,
      assetId: asset.id,
      variantId: variant.id,
      socialAccountIds: [project.accounts[0].id],
      scheduledFor: null,
      userId: null,
    });

    await expect(
      schedulePost({ postId, scheduledFor: new Date(), userId: null }),
    ).rejects.toBeInstanceOf(NotApprovedError);
  });

  it("refuses media a platform will not accept", async () => {
    const project = await createProjectFixture({
      slug: "too-long",
      platforms: [Platform.INSTAGRAM],
    });
    // 240s exceeds Instagram's 90s ceiling.
    const asset = await createAssetFixture({
      projectId: project.id,
      seed: 13,
      durationSeconds: 240,
    });
    const variant = await createVariantFixture({ assetId: asset.id });

    await expect(
      createPost({
        projectId: project.id,
        assetId: asset.id,
        variantId: variant.id,
        socialAccountIds: [project.accounts[0].id],
        scheduledFor: null,
        userId: null,
      }),
    ).rejects.toThrow(/will not accept this media/);
  });

  it("refuses an account from another project", async () => {
    const mine = await createProjectFixture({ slug: "mine" });
    const theirs = await createProjectFixture({ slug: "theirs" });
    const asset = await createAssetFixture({ projectId: mine.id, seed: 14 });
    const variant = await createVariantFixture({ assetId: asset.id });

    await expect(
      createPost({
        projectId: mine.id,
        assetId: asset.id,
        variantId: variant.id,
        socialAccountIds: [theirs.accounts[0].id],
        scheduledFor: null,
        userId: null,
      }),
    ).rejects.toThrow(/do not belong to this project/);
  });

  it("queues on approval and cancels on rejection", async () => {
    const project = await createProjectFixture();
    const operator = await createOperator();
    const asset = await createAssetFixture({ projectId: project.id, seed: 15 });
    const variant = await createVariantFixture({ assetId: asset.id });

    const { postId } = await createPost({
      projectId: project.id,
      assetId: asset.id,
      variantId: variant.id,
      socialAccountIds: [project.accounts[0].id],
      scheduledFor: null,
      userId: operator.id,
    });

    await approvePost({
      postId,
      userId: operator.id,
      scheduledFor: new Date(Date.now() + 3_600_000),
    });

    const queued = await prisma.publishJob.findFirstOrThrow();
    expect(queued.status).toBe(JobStatus.QUEUED);

    await rejectPost({ postId, userId: operator.id, reason: "Hook is too long." });

    const cancelled = await prisma.publishJob.findFirstOrThrow();
    expect(cancelled.status).toBe(JobStatus.CANCELLED);

    const post = await prisma.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post.approvalState).toBe(ApprovalState.REJECTED);
    expect(post.rejectedReason).toBe("Hook is too long.");
    expect(post.scheduledFor).toBeNull();
  });

  it("removes the job when a post is unscheduled", async () => {
    const project = await createProjectFixture();
    const operator = await createOperator();
    const asset = await createAssetFixture({ projectId: project.id, seed: 16 });
    const variant = await createVariantFixture({ assetId: asset.id });

    const { postId } = await createPost({
      projectId: project.id,
      assetId: asset.id,
      variantId: variant.id,
      socialAccountIds: [project.accounts[0].id],
      scheduledFor: null,
      userId: operator.id,
    });
    await approvePost({
      postId,
      userId: operator.id,
      scheduledFor: new Date(Date.now() + 3_600_000),
    });
    await unschedulePost({ postId, userId: operator.id });

    const job = await prisma.publishJob.findFirstOrThrow();
    expect(job.status).toBe(JobStatus.CANCELLED);
    const post = await prisma.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post.status).toBe(PostStatus.APPROVED);
    expect(post.scheduledFor).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("publishing and duplicate prevention", () => {
  async function approvedPost(options: { seed: number; platforms?: Platform[] }) {
    const project = await createProjectFixture({
      slug: `pub-${options.seed}`,
      platforms: options.platforms ?? [Platform.TIKTOK],
    });
    const operator = await createOperator(`op-${options.seed}@test.local`);
    const asset = await createAssetFixture({ projectId: project.id, seed: options.seed });
    const variant = await createVariantFixture({ assetId: asset.id });

    const { postId } = await createPost({
      projectId: project.id,
      assetId: asset.id,
      variantId: variant.id,
      socialAccountIds: project.accounts.map((account) => account.id),
      scheduledFor: null,
      userId: operator.id,
    });
    await approvePost({ postId, userId: operator.id, scheduledFor: new Date() });

    return { project, operator, postId };
  }

  it("publishes through the simulator and records the step log", async () => {
    const { postId } = await approvedPost({ seed: 20 });
    const job = await prisma.publishJob.findFirstOrThrow();

    const result = await runPublishJob(job.id);
    expect(result.outcome).toBe("published");

    const finished = await prisma.publishJob.findUniqueOrThrow({
      where: { id: job.id },
      include: { attemptLog: true, postPlatform: true },
    });
    expect(finished.status).toBe(JobStatus.SUCCEEDED);
    expect(finished.postPlatform.status).toBe(PostPlatformStatus.PUBLISHED);
    expect(finished.postPlatform.publishedAt).toBeTruthy();
    expect(finished.postPlatform.remotePostId).toMatch(/^sim_/);

    const steps = finished.attemptLog[0].steps as Array<{ message: string }>;
    expect(steps.length).toBeGreaterThan(3);
    expect(steps.map((step) => step.message)).toContain("Media uploaded");

    const post = await prisma.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post.status).toBe(PostStatus.PUBLISHED);
  });

  it("never publishes the same destination twice", async () => {
    await approvedPost({ seed: 21 });
    const job = await prisma.publishJob.findFirstOrThrow();

    const first = await runPublishJob(job.id);
    expect(first.outcome).toBe("published");

    // Running the identical job again must be a no-op, not a second post.
    const second = await runPublishJob(job.id);
    expect(second.outcome).toBe("skipped");
    if (second.outcome === "skipped") {
      expect(second.reason).toMatch(/twice|already/i);
    }

    const attempts = await prisma.publishAttempt.count({ where: { jobId: job.id } });
    expect(attempts).toBe(1);
  });

  it("keeps the unique idempotency key so a duplicate job cannot be inserted", async () => {
    await approvedPost({ seed: 22 });
    const job = await prisma.publishJob.findFirstOrThrow();

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

  it("re-enqueueing an already published destination does not create work", async () => {
    const { postId } = await approvedPost({ seed: 23 });
    const job = await prisma.publishJob.findFirstOrThrow();
    await runPublishJob(job.id);

    const result = await enqueuePublish({ postId, runAt: new Date() });

    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await prisma.publishJob.count()).toBe(1);
  });

  it("marks the post FAILED when any destination fails", async () => {
    const { postId } = await approvedPost({
      seed: 24,
      platforms: [Platform.TIKTOK, Platform.YOUTUBE],
    });

    const jobs = await prisma.publishJob.findMany();
    expect(jobs).toHaveLength(2);

    await runPublishJob(jobs[0].id);
    // Force the second destination into a failed state to test the rollup.
    await prisma.postPlatform.update({
      where: { id: jobs[1].postPlatformId },
      data: { status: PostPlatformStatus.FAILED, lastError: "forced" },
    });
    const { syncPostStatus } = await import("@/server/automation/publish-runner");
    await syncPostStatus(postId);

    const post = await prisma.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post.status).toBe(PostStatus.FAILED);
  });

  it("cancelling clears queued jobs and resets the destinations", async () => {
    const { postId } = await approvedPost({ seed: 25 });

    const cancelled = await cancelPublish(postId);
    expect(cancelled).toBe(1);

    const target = await prisma.postPlatform.findFirstOrThrow({ where: { postId } });
    expect(target.status).toBe(PostPlatformStatus.PENDING);
  });

  it("does nothing for a job that no longer exists", async () => {
    const result = await runPublishJob("does-not-exist");
    expect(result.outcome).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------

describe("analytics", () => {
  it("captures one snapshot per age window and never overwrites history", async () => {
    const project = await createProjectFixture({ slug: "analytics" });
    const asset = await createAssetFixture({ projectId: project.id, seed: 30 });
    const variant = await createVariantFixture({ assetId: asset.id });

    const post = await prisma.post.create({
      data: {
        projectId: project.id,
        assetId: asset.id,
        variantId: variant.id,
        status: PostStatus.PUBLISHED,
        approvalState: ApprovalState.APPROVED,
        scheduledFor: new Date(),
        targets: {
          create: {
            socialAccountId: project.accounts[0].id,
            platform: project.accounts[0].platform,
            status: PostPlatformStatus.PUBLISHED,
            // 40 days old, so every window is due.
            publishedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          },
        },
      },
      include: { targets: true },
    });

    const first = await syncAnalytics();
    expect(first.snapshotsCreated).toBe(4);

    // A second sync must add nothing: the windows are already captured.
    const second = await syncAnalytics();
    expect(second.snapshotsCreated).toBe(0);

    const snapshots = await prisma.analyticsSnapshot.findMany({
      where: { postPlatformId: post.targets[0].id },
    });
    expect(snapshots).toHaveLength(4);
    expect(new Set(snapshots.map((snapshot) => snapshot.windowLabel))).toEqual(
      new Set(["1h", "24h", "7d", "30d"]),
    );
    // Everything must be labelled as simulated, never as platform data.
    for (const snapshot of snapshots) {
      expect(snapshot.source).toBe(MetricSource.SIMULATED);
    }
  });

  it("ignores posts that have not been published", async () => {
    const project = await createProjectFixture({ slug: "unpublished" });
    const asset = await createAssetFixture({ projectId: project.id, seed: 31 });
    const variant = await createVariantFixture({ assetId: asset.id });

    await prisma.post.create({
      data: {
        projectId: project.id,
        assetId: asset.id,
        variantId: variant.id,
        status: PostStatus.SCHEDULED,
        targets: {
          create: {
            socialAccountId: project.accounts[0].id,
            platform: project.accounts[0].platform,
            status: PostPlatformStatus.QUEUED,
          },
        },
      },
    });

    const summary = await syncAnalytics();
    expect(summary.postsChecked).toBe(0);
    expect(summary.snapshotsCreated).toBe(0);
  });

  it("reads each post from its most mature window", async () => {
    const project = await createProjectFixture({ slug: "maturity" });
    const asset = await createAssetFixture({ projectId: project.id, seed: 32 });
    const variant = await createVariantFixture({ assetId: asset.id });

    const post = await prisma.post.create({
      data: {
        projectId: project.id,
        assetId: asset.id,
        variantId: variant.id,
        status: PostStatus.PUBLISHED,
        targets: {
          create: {
            socialAccountId: project.accounts[0].id,
            platform: project.accounts[0].platform,
            status: PostPlatformStatus.PUBLISHED,
            publishedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
          },
        },
      },
      include: { targets: true },
    });

    await prisma.analyticsSnapshot.createMany({
      data: [
        { postPlatformId: post.targets[0].id, windowLabel: "1h", views: 10 },
        { postPlatformId: post.targets[0].id, windowLabel: "30d", views: 5_000 },
      ],
    });

    const facts = await loadPostFacts({ projectId: project.id });
    expect(facts).toHaveLength(1);
    expect(facts[0].windowLabel).toBe("30d");
    expect(facts[0].views).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------

describe("recommendation engine", () => {
  it("produces nothing from an empty dataset", async () => {
    const project = await createProjectFixture({ slug: "no-data" });
    const result = await refreshRecommendations(project.id);

    expect(result.created).toBe(0);
    expect(await prisma.recommendation.count()).toBe(0);
  });

  it("supersedes previous open recommendations instead of deleting them", async () => {
    const project = await createProjectFixture({ slug: "supersede" });

    await prisma.recommendation.create({
      data: {
        projectId: project.id,
        kind: "DOUBLE_DOWN",
        title: "Old suggestion",
        rationale: "From an earlier run.",
        evidence: {},
      },
    });

    await refreshRecommendations(project.id);

    const rows = await prisma.recommendation.findMany({ where: { projectId: project.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("SUPERSEDED");
  });

  it("caps confidence at LOW while the dataset is small", async () => {
    const project = await createProjectFixture({ slug: "small-sample" });
    const asset = await createAssetFixture({ projectId: project.id, seed: 40 });

    // Four published posts sharing one hook pattern, with a huge spread.
    for (let index = 0; index < 4; index += 1) {
      const variant = await createVariantFixture({
        assetId: asset.id,
        hook: "POV: this is post number " + index,
      });
      const post = await prisma.post.create({
        data: {
          projectId: project.id,
          assetId: asset.id,
          variantId: variant.id,
          status: PostStatus.PUBLISHED,
          targets: {
            create: {
              socialAccountId: project.accounts[0].id,
              platform: project.accounts[0].platform,
              status: PostPlatformStatus.PUBLISHED,
              publishedAt: new Date(Date.now() - (index + 2) * 24 * 60 * 60 * 1000),
            },
          },
        },
        include: { targets: true },
      });
      await prisma.analyticsSnapshot.create({
        data: {
          postPlatformId: post.targets[0].id,
          windowLabel: "24h",
          views: index === 0 ? 100_000 : 1_000,
        },
      });
    }

    await refreshRecommendations(project.id);
    const rows = await prisma.recommendation.findMany({
      where: { projectId: project.id, status: "OPEN" },
    });

    // Below the dataset minimum nothing may claim high or medium confidence.
    for (const row of rows) {
      expect(row.confidence).toBe("LOW");
    }
  });
});

// ---------------------------------------------------------------------------

describe("authentication", () => {
  it("rejects a wrong password and an unknown address identically", async () => {
    await createOperator("real@test.local");

    const wrongPassword = await authenticate({
      email: "real@test.local",
      password: "nope",
    });
    const unknownUser = await authenticate({
      email: "ghost@test.local",
      password: "nope",
    });

    expect(wrongPassword.ok).toBe(false);
    expect(unknownUser.ok).toBe(false);
    if (!wrongPassword.ok && !unknownUser.ok) {
      expect(wrongPassword.reason).toBe(unknownUser.reason);
    }
  });

  it("stores only a hash of the session token", async () => {
    await createOperator("session@test.local");

    const result = await authenticate({
      email: "session@test.local",
      password: "correct horse battery staple",
    });
    expect(result.ok).toBe(true);

    const session = await prisma.userSession.findFirstOrThrow();
    // A 64-character hex digest, not the token itself.
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    if (result.ok) {
      expect(session.tokenHash).not.toBe(result.token);
      // The issued token still resolves back to its user.
      await expect(resolveSession(result.token)).resolves.toMatchObject({
        email: "session@test.local",
      });
    }
  });

  it("revoking a session stops the token resolving", async () => {
    await createOperator("revoke@test.local");
    const result = await authenticate({
      email: "revoke@test.local",
      password: "correct horse battery staple",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await prisma.userSession.updateMany({ data: { revokedAt: new Date() } });
    await expect(resolveSession(result.token)).resolves.toBeNull();
  });

  it("does not accept an expired session", async () => {
    const user = await createOperator("expired@test.local");
    await prisma.userSession.create({
      data: {
        userId: user.id,
        tokenHash: "f".repeat(64),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    // An expired row must not resolve, and pruning must remove it.
    await expect(resolveSession("whatever")).resolves.toBeNull();
    expect(await pruneSessions()).toBe(1);
    expect(await prisma.userSession.count()).toBe(0);
  });
});
