import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { approvePost, createPost, schedulePost } from "@/server/services/post-service";
import { closeQueues, queues } from "@/server/jobs/queues";
import { sweepDueJobs } from "@/server/services/publish-service";
import {
  cleanupTestStorage,
  createAssetFixture,
  createOperator,
  createProjectFixture,
  createVariantFixture,
  migrateTestSchema,
  resetDatabase,
} from "./helpers";
import { JobStatus, Platform } from "@/generated/prisma/enums";

/**
 * Rescheduling has to reach BOTH stores.
 *
 * Postgres records the intent and Redis carries the delay, and it is entirely
 * possible for the first to change while the second does not — BullMQ ignores an
 * `add` for a job id it already holds, which is exactly the bug these assertions
 * exist to catch. Checking only the database would pass while the job still
 * fired at the old time.
 *
 * Runs against the real Redis under a test-only key prefix.
 */

let redisAvailable = true;

beforeAll(async () => {
  await migrateTestSchema();
  try {
    await queues.publishing().getJobCounts("waiting");
  } catch {
    redisAvailable = false;
  }
});

beforeEach(async () => {
  await resetDatabase();
  if (redisAvailable) {
    await queues.publishing().obliterate({ force: true });
  }
});

afterAll(async () => {
  if (redisAvailable) {
    await queues.publishing().obliterate({ force: true }).catch(() => {});
  }
  await resetDatabase();
  await cleanupTestStorage();
  await closeQueues().catch(() => {});
  await prisma.$disconnect();
});

async function approvedPost(seed: number, scheduledFor: Date) {
  const project = await createProjectFixture({
    slug: `resched-${seed}`,
    platforms: [Platform.TIKTOK],
  });
  const operator = await createOperator(`resched-${seed}@test.local`);
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
  await approvePost({ postId, userId: operator.id, scheduledFor });
  return { postId, operator };
}

describe("rescheduling", () => {
  it("moves the time in Postgres and the delay in Redis together", async () => {
    if (!redisAvailable) return;

    const first = new Date(Date.now() + 30 * 60 * 1000);
    const { postId, operator } = await approvedPost(1, first);

    const job = await prisma.publishJob.findFirstOrThrow();
    const queuedBefore = await queues.publishing().getJob(job.id);
    expect(queuedBefore).toBeTruthy();
    const delayBefore = queuedBefore!.opts.delay ?? 0;
    // ~30 minutes out, allowing for execution time.
    expect(delayBefore).toBeGreaterThan(25 * 60 * 1000);

    // Move it much earlier.
    const second = new Date(Date.now() + 3 * 60 * 1000);
    await schedulePost({ postId, scheduledFor: second, userId: operator.id });

    const afterDb = await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterDb.runAt.getTime()).toBeCloseTo(second.getTime(), -3);

    const post = await prisma.post.findUniqueOrThrow({ where: { id: postId } });
    expect(post.scheduledFor?.getTime()).toBeCloseTo(second.getTime(), -3);

    const queuedAfter = await queues.publishing().getJob(job.id);
    expect(queuedAfter).toBeTruthy();
    const delayAfter = queuedAfter!.opts.delay ?? 0;
    // The delay must actually have moved, not merely the database row.
    expect(delayAfter).toBeLessThan(delayBefore);
    expect(delayAfter).toBeLessThan(5 * 60 * 1000);
  });

  it("still holds exactly one queue entry after rescheduling", async () => {
    if (!redisAvailable) return;

    const { postId, operator } = await approvedPost(2, new Date(Date.now() + 20 * 60 * 1000));
    await schedulePost({
      postId,
      scheduledFor: new Date(Date.now() + 10 * 60 * 1000),
      userId: operator.id,
    });
    await schedulePost({
      postId,
      scheduledFor: new Date(Date.now() + 5 * 60 * 1000),
      userId: operator.id,
    });

    const counts = await queues.publishing().getJobCounts("delayed", "waiting");
    expect((counts.delayed ?? 0) + (counts.waiting ?? 0)).toBe(1);
    expect(await prisma.publishJob.count()).toBe(1);
  });

  it("the sweeper promotes an overdue delayed job instead of adding a second", async () => {
    if (!redisAvailable) return;

    await approvedPost(3, new Date(Date.now() + 45 * 60 * 1000));
    const job = await prisma.publishJob.findFirstOrThrow();

    // The database says it is due now; Redis still holds the old delay.
    await prisma.publishJob.update({
      where: { id: job.id },
      data: { runAt: new Date(Date.now() - 60_000) },
    });

    const requeued = await sweepDueJobs();
    expect(requeued).toBe(1);

    const counts = await queues.publishing().getJobCounts("delayed", "waiting", "active");
    expect((counts.delayed ?? 0)).toBe(0);
    expect((counts.waiting ?? 0) + (counts.active ?? 0)).toBe(1);

    const after = await prisma.publishJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(after.status).toBe(JobStatus.QUEUED);
  });

  it("uses the test key prefix, never the development one", async () => {
    if (!redisAvailable) return;
    expect(process.env.QUEUE_PREFIX).toBe("bull-test");
  });
});
