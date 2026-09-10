import { env } from "@/env";
import { prisma } from "@/server/db";
import { getAdapter } from "@/server/platforms/registry";
import { simulateMetrics } from "@/server/automation/simulator";
import { withAccountSession } from "@/server/automation/browser";
import { activityActions, recordActivitySafe } from "@/server/activity/log";
import {
  ActorType,
  MetricSource,
  PostPlatformStatus,
} from "@/generated/prisma/enums";

/**
 * Metric capture.
 *
 * Snapshots are append-only and bucketed by post age. A given destination gets
 * at most one snapshot per window, so "views at 24h" stays comparable across
 * every post regardless of when the sync happened to run. History is never
 * rewritten — that is what makes the learning engine trustworthy.
 */

export const WINDOWS: Array<{ label: string; ageMs: number }> = [
  { label: "1h", ageMs: 60 * 60 * 1000 },
  { label: "24h", ageMs: 24 * 60 * 60 * 1000 },
  { label: "7d", ageMs: 7 * 24 * 60 * 60 * 1000 },
  { label: "30d", ageMs: 30 * 24 * 60 * 60 * 1000 },
];

/** Windows a post is old enough to have reached. */
export function dueWindows(publishedAt: Date, now = new Date()): string[] {
  const age = now.getTime() - publishedAt.getTime();
  return WINDOWS.filter((window) => age >= window.ageMs).map((w) => w.label);
}

export type SyncSummary = {
  postsChecked: number;
  snapshotsCreated: number;
  errors: Array<{ postPlatformId: string; message: string }>;
};

export async function syncAnalytics(input: {
  projectId?: string;
  now?: Date;
} = {}): Promise<SyncSummary> {
  const now = input.now ?? new Date();

  const targets = await prisma.postPlatform.findMany({
    where: {
      status: PostPlatformStatus.PUBLISHED,
      publishedAt: { not: null },
      ...(input.projectId ? { post: { projectId: input.projectId } } : {}),
    },
    include: {
      snapshots: { select: { windowLabel: true } },
      account: true,
      post: {
        include: {
          variant: { select: { hook: true } },
          project: { select: { id: true, name: true } },
        },
      },
    },
  });

  const summary: SyncSummary = {
    postsChecked: targets.length,
    snapshotsCreated: 0,
    errors: [],
  };

  for (const target of targets) {
    if (!target.publishedAt) continue;

    const existing = new Set(target.snapshots.map((s) => s.windowLabel));
    const missing = dueWindows(target.publishedAt, now).filter(
      (label) => !existing.has(label),
    );
    if (missing.length === 0) continue;

    for (const windowLabel of missing) {
      try {
        const { metrics, source } = await collectMetrics({
          postPlatformId: target.id,
          socialAccountId: target.socialAccountId,
          platform: target.platform,
          remotePostId: target.remotePostId,
          hook: target.post.variant.hook,
          publishedAt: target.publishedAt,
          windowLabel,
        });

        await prisma.analyticsSnapshot.create({
          data: {
            postPlatformId: target.id,
            windowLabel,
            source,
            // capturedAt is the real capture time, not the window boundary.
            capturedAt: now,
            ...metrics,
          },
        });
        summary.snapshotsCreated += 1;
      } catch (error) {
        summary.errors.push({
          postPlatformId: target.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (summary.snapshotsCreated > 0) {
    await recordActivitySafe({
      action: activityActions.analyticsSynced,
      message: `Analytics sync captured ${summary.snapshotsCreated} snapshot(s) across ${summary.postsChecked} published destination(s)`,
      projectId: input.projectId ?? null,
      actorType: ActorType.WORKER,
      metadata: { errors: summary.errors.length },
    });
  }

  return summary;
}

/**
 * Where a metric actually comes from. With live publishing off, the simulator
 * supplies deterministic numbers and every snapshot is stamped SIMULATED so the
 * UI can never present them as real platform data.
 */
async function collectMetrics(input: {
  postPlatformId: string;
  socialAccountId: string;
  platform: Parameters<typeof getAdapter>[0];
  remotePostId: string | null;
  hook: string;
  publishedAt: Date;
  windowLabel: string;
}): Promise<{
  metrics: {
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    profileVisits: number;
    linkClicks: number;
    conversions: number;
    followerDelta: number;
    watchTimeSeconds: number;
    completionRate: number;
  };
  source: MetricSource;
}> {
  const adapter = getAdapter(input.platform);

  const canCollectLive =
    env.enableLivePublishing &&
    adapter.capabilities.metrics !== "UNSUPPORTED" &&
    typeof adapter.collectMetrics === "function" &&
    input.remotePostId !== null;

  if (!canCollectLive) {
    return {
      metrics: simulateMetrics({
        postPlatformId: input.postPlatformId,
        hook: input.hook,
        publishedAt: input.publishedAt,
        windowLabel: input.windowLabel,
        followerBase: 12_000,
      }),
      source: MetricSource.SIMULATED,
    };
  }

  const partial = await withAccountSession(
    input.socialAccountId,
    async (page) =>
      adapter.collectMetrics!({
        page,
        remotePostId: input.remotePostId!,
        log: async () => {},
      }),
    { headless: true },
  );

  return {
    metrics: {
      views: partial.views ?? 0,
      likes: partial.likes ?? 0,
      comments: partial.comments ?? 0,
      shares: partial.shares ?? 0,
      saves: partial.saves ?? 0,
      profileVisits: partial.profileVisits ?? 0,
      linkClicks: partial.linkClicks ?? 0,
      conversions: partial.conversions ?? 0,
      followerDelta: partial.followerDelta ?? 0,
      watchTimeSeconds: partial.watchTimeSeconds ?? 0,
      completionRate: partial.completionRate ?? 0,
    },
    source:
      adapter.capabilities.metrics === "OFFICIAL_API"
        ? MetricSource.OFFICIAL_API
        : MetricSource.BROWSER_ASSISTED,
  };
}
