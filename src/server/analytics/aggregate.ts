import { prisma } from "@/server/db";
import {
  ApprovalState,
  JobStatus,
  MetricSource,
  PostPlatformStatus,
  PostStatus,
  type ContentFormat,
  type Platform,
} from "@/generated/prisma/enums";

/**
 * Read models for the dashboard.
 *
 * One rule throughout: a post is read from its most mature snapshot for display,
 * and from a pinned common window whenever posts are compared to each other.
 * Mixing a 30-day post with a 1-hour post is how dashboards end up lying.
 */

export type PostFact = {
  postId: string;
  postPlatformId: string;
  projectId: string;
  projectName: string;
  projectAccent: string;
  platform: Platform;
  assetId: string;
  title: string;
  hook: string;
  cta: string;
  caption: string;
  hashtags: string[];
  variantLabel: string;
  format: ContentFormat | null;
  durationSeconds: number | null;
  publishedAt: Date;
  /** Local hour of day the post went out, 0..23. */
  publishedHour: number;
  publishedDayOfWeek: number;
  windowLabel: string;
  source: MetricSource;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  profileVisits: number;
  linkClicks: number;
  conversions: number;
  followerDelta: number;
  completionRate: number;
  watchTimeSeconds: number;
  engagementRate: number;
};

/**
 * Every published destination with its most mature snapshot. This is the single
 * dataset the learning engine and the analytics screens both read.
 */
export async function loadPostFacts(options: {
  projectId?: string;
  since?: Date;
  /**
   * Pin every post to this exact age window. Destinations that have not reached
   * it are excluded. Use this whenever posts of different ages are compared —
   * a 4-day-old post read at 7d against a 40-day-old post read at 30d is not a
   * comparison, it is an age difference wearing a performance costume.
   */
  window?: string;
} = {}): Promise<PostFact[]> {
  const targets = await prisma.postPlatform.findMany({
    where: {
      status: PostPlatformStatus.PUBLISHED,
      publishedAt: options.since ? { gte: options.since } : { not: null },
      ...(options.projectId ? { post: { projectId: options.projectId } } : {}),
    },
    include: {
      snapshots: { orderBy: { capturedAt: "desc" } },
      post: {
        include: {
          project: { select: { id: true, name: true, accentColor: true } },
          variant: true,
          asset: {
            include: {
              analyses: { orderBy: { createdAt: "desc" }, take: 1 },
            },
          },
        },
      },
    },
  });

  const facts: PostFact[] = [];

  for (const target of targets) {
    if (!target.publishedAt) continue;
    const snapshot = options.window
      ? (target.snapshots.find((entry) => entry.windowLabel === options.window) ?? null)
      : pickMostMature(target.snapshots);
    if (!snapshot) continue;

    const engagementBase = snapshot.views || 1;
    facts.push({
      postId: target.postId,
      postPlatformId: target.id,
      projectId: target.post.projectId,
      projectName: target.post.project.name,
      projectAccent: target.post.project.accentColor,
      platform: target.platform,
      assetId: target.post.assetId,
      title: target.post.asset.title,
      hook: target.post.variant.hook,
      cta: target.post.variant.cta,
      caption: target.post.variant.caption,
      hashtags: target.post.variant.hashtags,
      variantLabel: target.post.variant.label,
      format: target.post.asset.analyses[0]?.format ?? null,
      durationSeconds: target.post.asset.durationSeconds,
      publishedAt: target.publishedAt,
      publishedHour: target.publishedAt.getHours(),
      publishedDayOfWeek: target.publishedAt.getDay(),
      windowLabel: snapshot.windowLabel,
      source: snapshot.source,
      views: snapshot.views,
      likes: snapshot.likes,
      comments: snapshot.comments,
      shares: snapshot.shares,
      saves: snapshot.saves,
      profileVisits: snapshot.profileVisits,
      linkClicks: snapshot.linkClicks,
      conversions: snapshot.conversions,
      followerDelta: snapshot.followerDelta,
      completionRate: snapshot.completionRate,
      watchTimeSeconds: snapshot.watchTimeSeconds,
      engagementRate:
        (snapshot.likes + snapshot.comments + snapshot.shares + snapshot.saves) /
        engagementBase,
    });
  }

  return facts;
}

const WINDOW_ORDER = ["1h", "24h", "7d", "30d"];

function pickMostMature<T extends { windowLabel: string }>(
  snapshots: T[],
): T | null {
  if (snapshots.length === 0) return null;
  return [...snapshots].sort(
    (a, b) =>
      WINDOW_ORDER.indexOf(b.windowLabel) - WINDOW_ORDER.indexOf(a.windowLabel),
  )[0];
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

// ---------------------------------------------------------------------------
// Dashboard read models
// ---------------------------------------------------------------------------

export type TodayCounts = {
  scheduled: number;
  ready: number;
  needsApproval: number;
  failed: number;
  published: number;
  uploading: number;
};

export async function todayCounts(projectId?: string): Promise<TodayCounts> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  const scope = projectId ? { projectId } : {};

  const [scheduled, ready, needsApproval, failed, published, uploading] =
    await Promise.all([
      prisma.post.count({
        where: {
          ...scope,
          status: PostStatus.SCHEDULED,
          scheduledFor: { gte: startOfDay, lt: endOfDay },
        },
      }),
      prisma.post.count({ where: { ...scope, status: PostStatus.APPROVED } }),
      prisma.post.count({
        where: { ...scope, approvalState: ApprovalState.PENDING },
      }),
      prisma.post.count({ where: { ...scope, status: PostStatus.FAILED } }),
      prisma.postPlatform.count({
        where: {
          ...(projectId ? { post: { projectId } } : {}),
          status: PostPlatformStatus.PUBLISHED,
          publishedAt: { gte: startOfDay, lt: endOfDay },
        },
      }),
      prisma.post.count({ where: { ...scope, status: PostStatus.UPLOADING } }),
    ]);

  return { scheduled, ready, needsApproval, failed, published, uploading };
}

export type PerformanceTotals = {
  views: number;
  engagementRate: number;
  profileVisits: number;
  linkClicks: number;
  conversions: number;
  publishedCount: number;
  medianViews: number;
};

export function totalsFromFacts(facts: PostFact[]): PerformanceTotals {
  const views = sum(facts.map((f) => f.views));
  const interactions = sum(
    facts.map((f) => f.likes + f.comments + f.shares + f.saves),
  );
  return {
    views,
    engagementRate: views > 0 ? interactions / views : 0,
    profileVisits: sum(facts.map((f) => f.profileVisits)),
    linkClicks: sum(facts.map((f) => f.linkClicks)),
    conversions: sum(facts.map((f) => f.conversions)),
    publishedCount: facts.length,
    medianViews: median(facts.map((f) => f.views)),
  };
}

export type ProjectSummary = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  accentColor: string;
  status: string;
  publishPolicy: string;
  scheduledCount: number;
  publishedCount: number;
  totals: PerformanceTotals;
  /** Recent performance as a multiple of this project's own all-time median. */
  momentum: number | null;
  /** Posts old enough to carry the momentum window. Momentum needs six. */
  comparableCount: number;
  accountCount: number;
  connectedAccountCount: number;
};

export async function projectSummaries(): Promise<ProjectSummary[]> {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      _count: { select: { accounts: true } },
      accounts: { select: { status: true } },
    },
  });

  const facts = await loadPostFacts();
  // Momentum compares recent posts to older ones, so it must read every post at
  // the same age. 24h is the earliest window every published post reaches.
  const comparableFacts = await loadPostFacts({ window: MOMENTUM_WINDOW });

  const summaries: ProjectSummary[] = [];
  for (const project of projects) {
    const projectFacts = facts.filter((f) => f.projectId === project.id);
    const projectComparable = comparableFacts.filter(
      (f) => f.projectId === project.id,
    );
    const [scheduledCount] = await Promise.all([
      prisma.post.count({
        where: { projectId: project.id, status: PostStatus.SCHEDULED },
      }),
    ]);

    summaries.push({
      id: project.id,
      slug: project.slug,
      name: project.name,
      description: project.description,
      accentColor: project.accentColor,
      status: project.status,
      publishPolicy: project.publishPolicy,
      scheduledCount,
      publishedCount: projectFacts.length,
      totals: totalsFromFacts(projectFacts),
      momentum: recentMomentum(projectComparable),
      comparableCount: projectComparable.length,
      accountCount: project._count.accounts,
      connectedAccountCount: project.accounts.filter(
        (account) => account.status === "CONNECTED",
      ).length,
    });
  }

  return summaries;
}

/** The age window momentum is measured at. See loadPostFacts({ window }). */
export const MOMENTUM_WINDOW = "24h";

/**
 * The five most recent posts' median views over the project's all-time median.
 *
 * Callers must pass facts pinned to one age window — otherwise recent posts are
 * read at a younger window than old ones and every project looks like it is
 * declining. Returns null below six posts, because a "3.4x median" from four
 * posts is noise dressed as insight.
 */
export function recentMomentum(facts: PostFact[]): number | null {
  if (facts.length < 6) return null;
  const sorted = [...facts].sort(
    (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime(),
  );
  const recent = median(sorted.slice(0, 5).map((f) => f.views));
  const allTime = median(sorted.map((f) => f.views));
  if (allTime === 0) return null;
  return Math.round((recent / allTime) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export type DailyPoint = {
  date: string;
  views: number;
  posts: number;
  engagementRate: number;
};

/** Daily rollup for the dashboard chart, zero-filled across the whole range. */
export function dailySeries(facts: PostFact[], days = 30): DailyPoint[] {
  const buckets = new Map<string, PostFact[]>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(day.getDate() - offset);
    buckets.set(day.toISOString().slice(0, 10), []);
  }

  for (const fact of facts) {
    const key = fact.publishedAt.toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(fact);
  }

  return [...buckets.entries()].map(([date, dayFacts]) => {
    const views = sum(dayFacts.map((f) => f.views));
    const interactions = sum(
      dayFacts.map((f) => f.likes + f.comments + f.shares + f.saves),
    );
    return {
      date,
      views,
      posts: dayFacts.length,
      engagementRate: views > 0 ? interactions / views : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Operational health
// ---------------------------------------------------------------------------

export type JobHealth = {
  status: JobStatus;
  count: number;
};

export async function jobHealth(): Promise<JobHealth[]> {
  const grouped = await prisma.publishJob.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  return grouped.map((row) => ({
    status: row.status,
    count: row._count._all,
  }));
}

export async function recentActivity(limit = 40, projectId?: string) {
  return prisma.activityLog.findMany({
    where: projectId ? { projectId } : {},
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      project: { select: { name: true, accentColor: true } },
      user: { select: { name: true } },
    },
  });
}
