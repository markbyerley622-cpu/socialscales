import "@/lib/load-env";
import { Worker, type Job } from "bullmq";
import { env } from "@/env";
import { prisma } from "@/server/db";
import {
  QUEUE_NAMES,
  connection,
  type AccountsJob,
  type AnalyticsSyncJob,
  type ContentAnalysisJob,
  type PublishingJob,
  type RecommendationsJob,
  type TrendDiscoveryJob,
} from "@/server/jobs/queues";
import { analyzeAsset } from "@/server/services/content-service";
import { runPublishJob } from "@/server/automation/publish-runner";
import { sweepDueJobs } from "@/server/services/publish-service";
import { syncAnalytics } from "@/server/analytics/snapshots";
import { refreshRecommendations } from "@/server/learning/recommendations";
import { refreshTrends } from "@/server/learning/trends";
import { connectAccount, verifyAccount } from "@/server/automation/connect-account";
import { pruneSessions } from "@/server/auth/session";

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
    { connection, concurrency: 4 },
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
    { connection, concurrency: 1 },
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
    { connection, concurrency: 2 },
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
    { connection, concurrency: 1 },
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
    { connection, concurrency: 1 },
  ),
);

// ---------------------------------------------------------------------------
// accounts (connect is long-running: a human completes the login)
// ---------------------------------------------------------------------------

workers.push(
  new Worker<AccountsJob>(
    QUEUE_NAMES.accounts,
    async (job: Job<AccountsJob>) => {
      if (job.data.action === "connect") {
        log("accounts", `opening a browser for ${job.data.socialAccountId}`);
        const result = await connectAccount(job.data.socialAccountId);
        log("accounts", `connect → ${result.ok ? "connected" : result.reason}`);
        return result;
      }
      const result = await verifyAccount(job.data.socialAccountId);
      log("accounts", `verify → ${result.ok ? "valid" : result.reason}`);
      return result;
    },
    { connection, concurrency: 1, lockDuration: 10 * 60 * 1000 },
  ),
);

// ---------------------------------------------------------------------------
// Periodic reconciliation, run in-process rather than as a queue
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const sweepTimer = setInterval(() => {
  void sweepDueJobs()
    .then((count) => {
      if (count > 0) log("sweeper", `re-queued ${count} due job(s)`);
    })
    .catch((error) => log("sweeper", "failed", error));
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
  await Promise.all(workers.map((worker) => worker.close()));
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
