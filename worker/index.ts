import "@/lib/load-env";
import { Worker, type Job } from "bullmq";
import { env } from "@/env";
import { prisma } from "@/server/db";
import {
  QUEUE_NAMES,
  QUEUE_PREFIX,
  connection,
  type AccountsJob,
  type AnalyticsSyncJob,
  type ContentAnalysisJob,
  type PublishingJob,
  type RecommendationsJob,
  type RenderingJob,
  type TrendDiscoveryJob,
} from "@/server/jobs/queues";
import { analyzeAsset } from "@/server/services/content-service";
import {
  reconcileUnverified,
  runPublishJob,
} from "@/server/automation/publish-runner";
import {
  sweepDueJobs,
  unblockAccountJobs,
} from "@/server/services/publish-service";
import { syncAnalytics } from "@/server/analytics/snapshots";
import { refreshRecommendations } from "@/server/learning/recommendations";
import { refreshTrends } from "@/server/learning/trends";
import { connectAccount, verifyAccount } from "@/server/automation/connect-account";
import { pruneSessions } from "@/server/auth/session";
import { reportWorkerStatus } from "@/server/jobs/worker-status";
import { reclaimStaleRenders, runRenderJob } from "@/server/rendering";

/**
 * The CONTENT OS worker.
 *
 * Run alongside the web app: `npm run worker`.
 *
 * Concurrency is deliberately low for publishing (1) because each job may drive a
 * real browser, and platforms are entitled to expect one action at a time from an
 * account. Analysis and analytics run wider.
 */

const workers: Worker[] = [];

function log(scope: string, message: string, extra?: unknown): void {
  const stamp = new Date().toISOString();
  if (extra === undefined) console.log(`${stamp} [${scope}] ${message}`);
  else console.log(`${stamp} [${scope}] ${message}`, extra);
}

// ---------------------------------------------------------------------------
// content-analysis
// ---------------------------------------------------------------------------

workers.push(
  new Worker<ContentAnalysisJob>(
    QUEUE_NAMES.contentAnalysis,
    async (job: Job<ContentAnalysisJob>) => {
      log("content-analysis", `analyzing asset ${job.data.assetId}`);
      const result = await analyzeAsset({
        assetId: job.data.assetId,
        userId: job.data.userId,
      });
      log(
        "content-analysis",
        `asset ${job.data.assetId} → ${result.format}, ${result.variantIds.length} variants`,
      );
      return result;
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 4 },
  ),
);

// ---------------------------------------------------------------------------
// publishing
// ---------------------------------------------------------------------------

workers.push(
  new Worker<PublishingJob>(
    QUEUE_NAMES.publishing,
    async (job: Job<PublishingJob>) => {
      log("publishing", `running publish job ${job.data.publishJobId}`);
      const result = await runPublishJob(job.data.publishJobId);
      log("publishing", `job ${job.data.publishJobId} → ${result.outcome}`, result);

      // Let BullMQ retry only when the runner says the failure is retryable.
      if (result.outcome === "failed" && result.retryable) {
        throw new Error(result.error);
      }
      return result;
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 1 },
  ),
);

// ---------------------------------------------------------------------------
// analytics-sync
// ---------------------------------------------------------------------------

workers.push(
  new Worker<AnalyticsSyncJob>(
    QUEUE_NAMES.analyticsSync,
    async (job: Job<AnalyticsSyncJob>) => {
      const summary = await syncAnalytics({ projectId: job.data.projectId });
      log(
        "analytics-sync",
        `checked ${summary.postsChecked}, created ${summary.snapshotsCreated} snapshot(s), ${summary.errors.length} error(s)`,
      );

      // New data means the learning layer is stale.
      if (summary.snapshotsCreated > 0) {
        const projects = job.data.projectId
          ? [{ id: job.data.projectId }]
          : await prisma.project.findMany({ select: { id: true } });
        for (const project of projects) {
          await refreshRecommendations(project.id);
        }
      }
      return summary;
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 2 },
  ),
);

// ---------------------------------------------------------------------------
// trend-discovery
// ---------------------------------------------------------------------------

workers.push(
  new Worker<TrendDiscoveryJob>(
    QUEUE_NAMES.trendDiscovery,
    async (job: Job<TrendDiscoveryJob>) => {
      const projects = job.data.projectId
        ? [{ id: job.data.projectId }]
        : await prisma.project.findMany({ select: { id: true } });
      let total = 0;
      for (const project of projects) {
        total += await refreshTrends(project.id);
      }
      log("trend-discovery", `recorded ${total} observation(s)`);
      return { recorded: total };
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 1 },
  ),
);

// ---------------------------------------------------------------------------
// recommendations
// ---------------------------------------------------------------------------

workers.push(
  new Worker<RecommendationsJob>(
    QUEUE_NAMES.recommendations,
    async (job: Job<RecommendationsJob>) => {
      const projects = job.data.projectId
        ? [{ id: job.data.projectId }]
        : await prisma.project.findMany({ select: { id: true } });
      let created = 0;
      for (const project of projects) {
        const result = await refreshRecommendations(project.id);
        created += result.created;
      }
      log("recommendations", `created ${created} recommendation(s)`);
      return { created };
    },
    { connection, prefix: QUEUE_PREFIX, concurrency: 1 },
  ),
);

// ---------------------------------------------------------------------------
// accounts (connect is long-running: a human completes the login)
// ---------------------------------------------------------------------------

workers.push(
  new Worker<AccountsJob>(
    QUEUE_NAMES.accounts,
    async (job: Job<AccountsJob>) => {
      const { socialAccountId } = job.data;

      if (job.data.action === "connect") {
        log("accounts", `opening a browser for ${socialAccountId}`);
        const result = await connectAccount(socialAccountId);
        log("accounts", `connect → ${result.ok ? "connected" : result.reason}`);
        if (result.ok) {
          // Jobs blocked while the account was disconnected were never
          // attempted, so reconnecting simply makes them runnable again.
          const released = await unblockAccountJobs(socialAccountId);
          if (released > 0) {
            log("accounts", `released ${released} blocked publish job(s)`);
          }
        }
        return result;
      }

      const result = await verifyAccount(socialAccountId);
      log("accounts", `verify → ${result.ok ? "valid" : result.reason}`);
      if (result.ok) {
        const released = await unblockAccountJobs(socialAccountId);
        if (released > 0) {
          log("accounts", `released ${released} blocked publish job(s)`);
        }

        // The session is open and known good, so this is the cheapest moment to
        // confirm any publication whose verification was interrupted.
        try {
          const reconciled = await reconcileUnverified(socialAccountId);
          if (reconciled.checked > 0) {
            log(
              "accounts",
              `reconciled ${reconciled.verified}/${reconciled.checked} unverified publication(s)`,
            );
          }
        } catch (error) {
          log("accounts", "reconciliation failed", error);
        }
      }
      return result;
    },
    {
      connection,
      prefix: QUEUE_PREFIX,
      concurrency: 1,
      lockDuration: 10 * 60 * 1000,
    },
  ),
);

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

workers.push(
  new Worker<RenderingJob>(
    QUEUE_NAMES.rendering,
    async (job: Job<RenderingJob>) => {
      log("rendering", `rendering job ${job.data.renderJobId}`);
      const result = await runRenderJob(job.data.renderJobId);
      log("rendering", `job ${job.data.renderJobId} -> ${result.outcome}`, {
        outputAssetId: result.outputAssetId,
        durationMs: result.durationMs,
        errorKind: result.errorKind,
      });

      // BullMQ retries only what the runner says is worth retrying. A missing
      // asset or an out-of-range trim fails identically every time, and burning
      // three attempts on it just delays the operator seeing the real reason.
      if (result.outcome === "failed" && result.retryable) {
        throw new Error(result.error ?? "render failed");
      }
      return result;
    },
    {
      connection,
      prefix: QUEUE_PREFIX,
      // One at a time: ffmpeg saturates the CPU on its own, and two concurrent
      // encodes on one machine finish later than two sequential ones.
      concurrency: 1,
      // An encode can legitimately run for a long time without the worker
      // touching Redis, and a lock that expires mid-render hands the same job to
      // a second worker.
      lockDuration: 30 * 60 * 1000,
    },
  ),
);

// ---------------------------------------------------------------------------
// Periodic reconciliation, run in-process rather than as a queue
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// The console reads this to report whether publishing is actually live, rather
// than guessing from its own environment.
const WORKER_STARTED_AT = new Date();
void reportWorkerStatus(WORKER_STARTED_AT).catch((error) =>
  log("worker", "could not record worker status", error),
);

const heartbeatTimer = setInterval(() => {
  void reportWorkerStatus(WORKER_STARTED_AT).catch(() => {});
}, SWEEP_INTERVAL_MS);

const sweepTimer = setInterval(() => {
  void reportWorkerStatus(WORKER_STARTED_AT).catch(() => {});
  void sweepDueJobs()
    .then((count) => {
      if (count > 0) log("sweeper", `re-queued ${count} due job(s)`);
    })
    .catch((error) => log("sweeper", "failed", error));

  // A worker killed mid-encode leaves a row saying RUNNING that nothing else
  // will ever touch. Reclaiming it is safe because the idempotency key sends
  // the retry to the same output location.
  void reclaimStaleRenders()
    .then((count) => {
      if (count > 0) log("sweeper", `reclaimed ${count} stalled render(s)`);
    })
    .catch((error) => log("sweeper", "render reclaim failed", error));
}, SWEEP_INTERVAL_MS);

const pruneTimer = setInterval(() => {
  void pruneSessions()
    .then((count) => {
      if (count > 0) log("housekeeping", `pruned ${count} expired session(s)`);
    })
    .catch((error) => log("housekeeping", "failed", error));
}, PRUNE_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

for (const worker of workers) {
  worker.on("failed", (job, error) => {
    log(worker.name, `job ${job?.id} failed: ${error.message}`);
  });
  worker.on("error", (error) => {
    log(worker.name, `worker error: ${error.message}`);
  });
}

log(
  "worker",
  `CONTENT OS worker online — queues: ${workers.map((w) => w.name).join(", ")}`,
);
log(
  "worker",
  env.enableLivePublishing
    ? "LIVE PUBLISHING IS ENABLED: jobs will drive real browsers against real accounts."
    : "Live publishing is off; the publish simulator will run instead. Set ENABLE_LIVE_PUBLISHING=1 to change that.",
);

async function shutdown(signal: string): Promise<void> {
  log("worker", `${signal} received, draining`);
  clearInterval(sweepTimer);
  clearInterval(pruneTimer);
  clearInterval(heartbeatTimer);
  await Promise.all(workers.map((worker) => worker.close()));
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
