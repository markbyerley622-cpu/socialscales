import { prisma } from "@/server/db";
import { loadPostFacts, median } from "@/server/analytics/aggregate";
import { activityActions, recordActivitySafe } from "@/server/activity/log";
import { ActorType, TrendMomentum, type Platform } from "@/generated/prisma/enums";

/**
 * Trend discovery.
 *
 * No external trend API is configured in this repo, and there is no legitimate
 * public endpoint that hands over "what is trending" for these platforms without
 * an approved developer agreement. Rather than scrape, or invent numbers, this
 * derives trends from the one dataset we legitimately own: our own published
 * content and how it performed.
 *
 * A "trend" here is a hashtag or topic from our own library whose recent posts
 * are outperforming their own earlier posts. Momentum is measured, not guessed,
 * and `source` records exactly where it came from so nothing masquerades as
 * platform data.
 *
 * To add a real external source, implement a function with the same return shape
 * and register it in `SOURCES`.
 */

const SOURCE_LOCAL = "local-history";
const RECENT_WINDOW_DAYS = 14;
const MIN_OBSERVATIONS = 2;

export type DiscoveredTrend = {
  platform: Platform;
  topic: string;
  momentum: TrendMomentum;
  relevanceScore: number;
  recommendedAngle: string | null;
  source: string;
};

export async function discoverTrends(
  projectId: string,
): Promise<DiscoveredTrend[]> {
  const facts = await loadPostFacts({ projectId });
  if (facts.length < 4) return [];

  const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const overallMedian = median(facts.map((fact) => fact.views));
  if (overallMedian === 0) return [];

  // Group by hashtag, since that is our own topical vocabulary.
  const byTag = new Map<string, { recent: number[]; older: number[]; platform: Platform }>();

  for (const fact of facts) {
    for (const raw of fact.hashtags) {
      const tag = raw.replace(/^#/, "").toLowerCase();
      if (tag.length < 3) continue;
      const entry =
        byTag.get(tag) ?? { recent: [], older: [], platform: fact.platform };
      if (fact.publishedAt >= cutoff) entry.recent.push(fact.views);
      else entry.older.push(fact.views);
      byTag.set(tag, entry);
    }
  }

  const trends: DiscoveredTrend[] = [];

  for (const [tag, entry] of byTag) {
    const observations = entry.recent.length + entry.older.length;
    if (observations < MIN_OBSERVATIONS) continue;

    const recentMedian = entry.recent.length > 0 ? median(entry.recent) : 0;
    const olderMedian = entry.older.length > 0 ? median(entry.older) : 0;

    let momentum: TrendMomentum;
    if (entry.recent.length === 0) momentum = TrendMomentum.FALLING;
    else if (olderMedian === 0) momentum = TrendMomentum.RISING;
    else if (recentMedian >= olderMedian * 1.25) momentum = TrendMomentum.RISING;
    else if (recentMedian <= olderMedian * 0.8) momentum = TrendMomentum.FALLING;
    else momentum = TrendMomentum.STEADY;

    // Relevance = how this tag's posts do against the project median, capped at 1.
    const comparison = recentMedian > 0 ? recentMedian : olderMedian;
    const relevanceScore = Math.min(1, comparison / (overallMedian * 1.5));

    trends.push({
      platform: entry.platform,
      topic: `#${tag}`,
      momentum,
      relevanceScore: Math.round(relevanceScore * 100) / 100,
      recommendedAngle:
        momentum === TrendMomentum.RISING
          ? `Recent #${tag} posts are outperforming your earlier ones. Make another one while it is working.`
          : momentum === TrendMomentum.FALLING
            ? `#${tag} has cooled off. Either refresh the angle or move the effort elsewhere.`
            : null,
      source: SOURCE_LOCAL,
    });
  }

  return trends
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 12);
}

/**
 * Records a fresh observation set. Trends are append-only observations with a
 * timestamp, not rows that get mutated, so "what did we think was rising last
 * month" stays answerable.
 */
export async function refreshTrends(projectId: string): Promise<number> {
  const trends = await discoverTrends(projectId);
  if (trends.length === 0) return 0;

  await prisma.trend.createMany({
    data: trends.map((trend) => ({
      projectId,
      platform: trend.platform,
      topic: trend.topic,
      momentum: trend.momentum,
      relevanceScore: trend.relevanceScore,
      recommendedAngle: trend.recommendedAngle,
      source: trend.source,
    })),
  });

  await recordActivitySafe({
    action: activityActions.trendsDiscovered,
    message: `Recorded ${trends.length} trend observation(s) from published performance history`,
    projectId,
    actorType: ActorType.WORKER,
    metadata: { source: SOURCE_LOCAL, count: trends.length },
  });

  return trends.length;
}

/** Latest observation per topic, for the Trends page. */
export async function latestTrends(projectId: string, limit = 12) {
  const rows = await prisma.trend.findMany({
    where: { projectId },
    orderBy: { observedAt: "desc" },
    take: 200,
  });

  const seen = new Set<string>();
  const latest = [];
  for (const row of rows) {
    if (seen.has(row.topic)) continue;
    seen.add(row.topic);
    latest.push(row);
    if (latest.length >= limit) break;
  }
  return latest;
}
