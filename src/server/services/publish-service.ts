import { prisma } from "@/server/db";
import { queueJobId, queues } from "@/server/jobs/queues";
import { activityActions, recordActivitySafe } from "@/server/activity/log";
import {
  ActorType,
  JobStatus,
  PostPlatformStatus,
} from "@/generated/prisma/enums";

/**
 * The bridge between "a post is scheduled" and "a worker publishes it".
 *
 * Two layers of duplicate protection:
 *  1. `PublishJob.idempotencyKey` is unique per PostPlatform, so the database
 *     rejects a second job for the same destination.
 *  2. The BullMQ job id is the PublishJob id, so re-enqueueing is a no-op in
 *     Redis too.
 *
 * Postgres is authoritative. If Redis is wiped, `sweepDueJobs` re-queues
 * everything that is due, and nothing is published twice because layer 1 holds.
 */

export function idempotencyKeyFor(postPlatformId: string): string {
  return `publish:${postPlatformId}`;
}

export type EnqueueResult = {
  created: number;
  reused: number;
  skipped: number;
};

export async function enqueuePublish(input: {
  postId: string;
  runAt: Date;
}): Promise<EnqueueResult> {
  const targets = await prisma.postPlatform.findMany({
    where: { postId: input.postId },
    include: { job: true, post: { select: { projectId: true } } },
  });

  const result: EnqueueResult = { created: 0, reused: 0, skipped: 0 };

  for (const target of targets) {
    // Never re-publish something that already went out.
    if (target.status === PostPlatformStatus.PUBLISHED) {
      result.skipped += 1;
      continue;
    }

    let job = target.job;

    if (job) {
      if (job.status === JobStatus.SUCCEEDED) {
        result.skipped += 1;
        continue;
      }
      job = await prisma.publishJob.update({
        where: { id: job.id },
        data: {
          runAt: input.runAt,
          status: JobStatus.QUEUED,
          lastError: null,
          finishedAt: null,
        },
      });
      result.reused += 1;
    } else {
      job = await prisma.publishJob.create({
        data: {
          postPlatformId: target.id,
          idempotencyKey: idempotencyKeyFor(target.id),
          runAt: input.runAt,
          status: JobStatus.QUEUED,
        },
      });
      result.created += 1;
    }

    await prisma.postPlatform.update({
      where: { id: target.id },
      data: { status: PostPlatformStatus.QUEUED, lastError: null },
    });

    await addToQueue(job.id, input.runAt);

    await recordActivitySafe({
      action: activityActions.publishQueued,
      message: `Queued ${target.platform} publish for ${input.runAt.toISOString()}`,
      projectId: target.post.projectId,
      actorType: ActorType.SYSTEM,
      entityType: "PublishJob",
      entityId: job.id,
    });
  }

  return result;
}

/**
 * Adds the delayed BullMQ job. Redis being unreachable is logged rather than
 * thrown: the PublishJob row is already committed, so the sweeper will pick it
 * up once Redis is back.
 */
async function addToQueue(publishJobId: string, runAt: Date): Promise<void> {
  const delay = Math.max(0, runAt.getTime() - Date.now());
  try {
    const queue = queues.publishing();

    // BullMQ silently ignores an add for an id it already holds. That would make
    // rescheduling a post a no-op in Redis — the job would still fire at the old
    // time — so a not-yet-running duplicate is removed first. A job that is
    // already active or finished is left alone; the unique idempotency key and
    // the runner's PUBLISHED check are what prevent a double publish.
    const existing = await queue.getJob(publishJobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "delayed" || state === "waiting" || state === "prioritized") {
        await existing.remove();
      }
    }

    await queue.add(
      "publish",
      { publishJobId },
      { jobId: publishJobId, delay },
    );
    await prisma.publishJob.update({
      where: { id: publishJobId },
      data: { queueJobId: publishJobId },
    });
  } catch (error) {
    console.error(
      `[publish] could not reach Redis to queue job ${publishJobId}; the sweeper will retry.`,
      error,
    );
    await prisma.publishJob.update({
      where: { id: publishJobId },
      data: { status: JobStatus.PENDING, queueJobId: null },
    });
  }
}

/** Cancels every outstanding job for a post. Published targets are left alone. */
export async function cancelPublish(postId: string): Promise<number> {
  const jobs = await prisma.publishJob.findMany({
    where: {
      postPlatform: { postId },
      status: { in: [JobStatus.PENDING, JobStatus.QUEUED, JobStatus.FAILED] },
    },
  });

  for (const job of jobs) {
    try {
      const queued = await queues.publishing().getJob(job.id);
      await queued?.remove();
    } catch (error) {
      console.warn(`[publish] could not remove queue job ${job.id}`, error);
    }
  }

  if (jobs.length > 0) {
    await prisma.$transaction([
      prisma.publishJob.updateMany({
        where: { id: { in: jobs.map((job) => job.id) } },
        data: { status: JobStatus.CANCELLED, finishedAt: new Date() },
      }),
      prisma.postPlatform.updateMany({
        where: {
          postId,
          status: { in: [PostPlatformStatus.QUEUED, PostPlatformStatus.FAILED] },
        },
        data: { status: PostPlatformStatus.PENDING },
      }),
    ]);
  }

  return jobs.length;
}

/** Operator-triggered retry of a failed job. */
export async function retryPublishJob(
  publishJobId: string,
  userId: string | null,
): Promise<void> {
  const job = await prisma.publishJob.findUniqueOrThrow({
    where: { id: publishJobId },
    include: { postPlatform: { include: { post: true } } },
  });

  if (job.postPlatform.status === PostPlatformStatus.PUBLISHED) {
    throw new Error("That destination has already published; nothing to retry.");
  }

  await prisma.publishJob.update({
    where: { id: publishJobId },
    data: {
      status: JobStatus.QUEUED,
      runAt: new Date(),
      lastError: null,
      finishedAt: null,
      // Give the operator a fresh budget of attempts.
      maxAttempts: job.attempts + 3,
    },
  });

  await prisma.postPlatform.update({
    where: { id: job.postPlatformId },
    data: { status: PostPlatformStatus.QUEUED, lastError: null },
  });

  // A fresh queue id, because the previous one may still be in Redis history.
  try {
    await queues.publishing().add(
      "publish",
      { publishJobId },
      { jobId: queueJobId(publishJobId, "retry", job.attempts + 1) },
    );
  } catch (error) {
    console.error("[publish] retry could not reach Redis", error);
    await prisma.publishJob.update({
      where: { id: publishJobId },
      data: { status: JobStatus.PENDING },
    });
  }

  await recordActivitySafe({
    action: activityActions.publishRetried,
    message: `Manual retry requested for ${job.postPlatform.platform}`,
    projectId: job.postPlatform.post.projectId,
    userId,
    actorType: userId ? ActorType.USER : ActorType.SYSTEM,
    entityType: "PublishJob",
    entityId: publishJobId,
  });
}

/**
 * Reconciles Postgres with Redis: any job that is due and not currently in the
 * queue gets re-added. Runs on a schedule in the worker.
 */
export async function sweepDueJobs(graceMs = 60_000): Promise<number> {
  const due = await prisma.publishJob.findMany({
    where: {
      status: { in: [JobStatus.PENDING, JobStatus.QUEUED] },
      runAt: { lte: new Date(Date.now() + graceMs) },
      postPlatform: { status: { not: PostPlatformStatus.PUBLISHED } },
    },
    take: 200,
  });

  let requeued = 0;
  for (const job of due) {
    try {
      const queue = queues.publishing();
      const existing = await queue.getJob(job.id);
      const state = await existing?.getState();

      // Already running: leave it be.
      if (existing && (state === "active" || state === "waiting")) continue;

      // Sitting on a delay that is now in the past — usually because the post
      // was rescheduled earlier. Promote it rather than adding a second job.
      if (existing && state === "delayed") {
        await existing.promote();
        await prisma.publishJob.update({
          where: { id: job.id },
          data: { status: JobStatus.QUEUED },
        });
        requeued += 1;
        continue;
      }

      // Completed, failed, or missing from Redis entirely: re-add it.
      await queue.add(
        "publish",
        { publishJobId: job.id },
        { jobId: queueJobId(job.id, "sweep", Date.now()) },
      );
      await prisma.publishJob.update({
        where: { id: job.id },
        data: { status: JobStatus.QUEUED },
      });
      requeued += 1;
    } catch (error) {
      console.error(`[publish] sweeper could not requeue ${job.id}`, error);
    }
  }
  return requeued;
}
