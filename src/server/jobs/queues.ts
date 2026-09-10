import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import { env } from "@/env";

/**
 * Queue definitions.
 *
 * Postgres is the source of truth for what needs publishing: every queued job
 * has a PublishJob row, and the sweeper reconciles the two. Redis is the
 * delivery mechanism, so losing Redis delays work but never loses it.
 */

export const QUEUE_NAMES = {
  contentAnalysis: "content-analysis",
  publishing: "publishing",
  analyticsSync: "analytics-sync",
  trendDiscovery: "trend-discovery",
  recommendations: "recommendations",
  accounts: "accounts",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Shared by every Queue and Worker so both sides agree on the namespace. */
export const QUEUE_PREFIX = env.queuePrefix;

export const connection: ConnectionOptions = {
  url: env.redisUrl,
  // BullMQ requires this for blocking commands.
  maxRetriesPerRequest: null,
};

/** Exponential backoff with a jittered base; retries are bounded, never infinite. */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: 60 * 60 * 24 * 7, count: 1_000 },
  removeOnFail: { age: 60 * 60 * 24 * 30 },
};

// Job payloads.
export type ContentAnalysisJob = { assetId: string; userId: string | null };
export type PublishingJob = { publishJobId: string };
export type AnalyticsSyncJob = { projectId?: string };
export type TrendDiscoveryJob = { projectId?: string };
export type RecommendationsJob = { projectId?: string };
export type AccountsJob =
  | { action: "connect"; socialAccountId: string }
  | { action: "verify"; socialAccountId: string };

const globalForQueues = globalThis as unknown as {
  contentOsQueues?: Map<string, Queue>;
};

const registry = globalForQueues.contentOsQueues ?? new Map<string, Queue>();
globalForQueues.contentOsQueues = registry;

function getQueue<T>(name: QueueName): Queue<T> {
  const existing = registry.get(name);
  if (existing) return existing as Queue<T>;
  const queue = new Queue<T>(name, {
    connection,
    prefix: env.queuePrefix,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  registry.set(name, queue);
  return queue;
}

export const queues = {
  contentAnalysis: () => getQueue<ContentAnalysisJob>(QUEUE_NAMES.contentAnalysis),
  publishing: () => getQueue<PublishingJob>(QUEUE_NAMES.publishing),
  analyticsSync: () => getQueue<AnalyticsSyncJob>(QUEUE_NAMES.analyticsSync),
  trendDiscovery: () => getQueue<TrendDiscoveryJob>(QUEUE_NAMES.trendDiscovery),
  recommendations: () => getQueue<RecommendationsJob>(QUEUE_NAMES.recommendations),
  accounts: () => getQueue<AccountsJob>(QUEUE_NAMES.accounts),
};

/**
 * Builds a BullMQ custom job id.
 *
 * BullMQ rejects any custom id containing ":" — it uses that character as its own
 * Redis key separator, and an id carrying one is refused at `add()` time. That
 * failure is easy to miss because callers often have a fallback path, so every
 * id is built here instead of being interpolated at the call site.
 */
export function queueJobId(...parts: Array<string | number>): string {
  return parts
    .map((part) => String(part).replace(/[:\s]+/g, "-"))
    .filter((part) => part.length > 0)
    .join("-");
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...registry.values()].map((queue) => queue.close()));
  registry.clear();
}

/** Queue depth per state, for the diagnostics view. */
export async function queueHealth(): Promise<
  Array<{
    name: string;
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  }>
> {
  const names = Object.values(QUEUE_NAMES);
  return Promise.all(
    names.map(async (name) => {
      const queue = getQueue(name);
      const counts = await queue.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed",
      );
      return {
        name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
      };
    }),
  );
}
