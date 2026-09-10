import { prisma } from "@/server/db";
import { AIJobStatus, AIProviderKind } from "@/generated/prisma/enums";
import type { AIOperation } from "@/generated/prisma/enums";

/**
 * What the AI layer has cost and how long it has taken.
 *
 * Read from `AIUsageLog` rather than `AIJob`, because the usage log has one row
 * per attempt: a job that needed two repairs cost three calls, and a report
 * built from job rows alone would understate it. Failed jobs are included for
 * the same reason — a call that produced nothing still billed.
 */

export type AiSpend = {
  jobs: number;
  attempts: number;
  /** Attempts that reached a provider and came back. */
  successfulAttempts: number;
  /** Attempts spent correcting output that failed validation. */
  repairAttempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Total provider wall-clock, not elapsed job time. */
  latencyMs: number;
  /** Jobs served without any language model. */
  deterministicJobs: number;
};

export type SpendWindow = {
  /** Omit to report across every workspace, which is what diagnostics wants. */
  workspaceId?: string;
  projectId?: string | null;
  operation?: AIOperation;
  since?: Date;
  until?: Date;
};

export async function aiSpend(window: SpendWindow): Promise<AiSpend> {
  const jobWhere = {
    ...(window.workspaceId ? { workspaceId: window.workspaceId } : {}),
    ...(window.projectId !== undefined ? { projectId: window.projectId } : {}),
    ...(window.operation ? { operation: window.operation } : {}),
    ...(window.since || window.until
      ? {
          createdAt: {
            ...(window.since ? { gte: window.since } : {}),
            ...(window.until ? { lt: window.until } : {}),
          },
        }
      : {}),
  };

  const [jobs, deterministicJobs, usage] = await Promise.all([
    prisma.aIJob.findMany({
      where: jobWhere,
      select: { id: true, repairAttempts: true },
    }),
    prisma.aIJob.count({
      where: { ...jobWhere, providerKind: AIProviderKind.DETERMINISTIC },
    }),
    prisma.aIUsageLog.findMany({
      where: { job: jobWhere },
      select: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        costUsd: true,
        latencyMs: true,
        ok: true,
      },
    }),
  ]);

  const total: AiSpend = {
    jobs: jobs.length,
    attempts: usage.length,
    successfulAttempts: 0,
    repairAttempts: jobs.reduce((sum, job) => sum + job.repairAttempts, 0),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    deterministicJobs,
  };

  for (const row of usage) {
    if (row.ok) total.successfulAttempts += 1;
    total.inputTokens += row.inputTokens;
    total.outputTokens += row.outputTokens;
    total.cacheReadTokens += row.cacheReadTokens;
    total.cacheWriteTokens += row.cacheWriteTokens;
    total.costUsd += row.costUsd;
    total.latencyMs += row.latencyMs;
  }
  total.costUsd = Math.round(total.costUsd * 1e6) / 1e6;

  return total;
}

/**
 * Spend over a trailing window.
 *
 * The cutoff is computed here rather than by the caller: a React server
 * component may not read the clock during render, and a diagnostics screen
 * asking "what did the last 30 days cost" should not have to know that.
 */
export async function recentAiSpend(
  days: number,
  window: Omit<SpendWindow, "since" | "until"> = {},
): Promise<AiSpend> {
  return aiSpend({ ...window, since: new Date(Date.now() - days * 86_400_000) });
}

export type OperationSpend = {
  operation: AIOperation;
  jobs: number;
  costUsd: number;
  /** Median is more useful than a mean here: one 90s outlier skews the mean. */
  medianLatencyMs: number;
  failureRate: number;
};

/** Per-operation breakdown, for spotting which feature is expensive or slow. */
export async function aiSpendByOperation(
  window: SpendWindow,
): Promise<OperationSpend[]> {
  const jobs = await prisma.aIJob.findMany({
    where: {
      ...(window.workspaceId ? { workspaceId: window.workspaceId } : {}),
      ...(window.projectId !== undefined ? { projectId: window.projectId } : {}),
      ...(window.since || window.until
        ? {
            createdAt: {
              ...(window.since ? { gte: window.since } : {}),
              ...(window.until ? { lt: window.until } : {}),
            },
          }
        : {}),
    },
    select: {
      operation: true,
      costUsd: true,
      latencyMs: true,
      status: true,
    },
  });

  const grouped = new Map<AIOperation, { costUsd: number; latencies: number[]; failures: number }>();
  for (const job of jobs) {
    const bucket = grouped.get(job.operation) ?? { costUsd: 0, latencies: [], failures: 0 };
    bucket.costUsd += job.costUsd;
    bucket.latencies.push(job.latencyMs);
    if (job.status !== AIJobStatus.SUCCEEDED) bucket.failures += 1;
    grouped.set(job.operation, bucket);
  }

  return [...grouped.entries()]
    .map(([operation, bucket]) => ({
      operation,
      jobs: bucket.latencies.length,
      costUsd: Math.round(bucket.costUsd * 1e6) / 1e6,
      medianLatencyMs: median(bucket.latencies),
      failureRate:
        bucket.latencies.length === 0 ? 0 : bucket.failures / bucket.latencies.length,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}
