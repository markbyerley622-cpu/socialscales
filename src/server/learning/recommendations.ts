import { prisma } from "@/server/db";
import { loadPostFacts, median, type PostFact } from "@/server/analytics/aggregate";
import { activityActions, recordActivitySafe } from "@/server/activity/log";
import {
  allReports,
  classifyHook,
  MIN_GROUP,
  TIME_WINDOWS,
  type DimensionReport,
  type GroupPerformance,
} from "./engine";
import {
  ActorType,
  Confidence,
  RecommendationKind,
  RecommendationStatus,
  type ContentFormat,
} from "@/generated/prisma/enums";

/**
 * Turns dimension reports into concrete, evidence-carrying suggestions.
 *
 * Two kinds get produced:
 *  - DOUBLE_DOWN / TIMING / FORMAT / CTA: a group that beat the project median
 *    with enough sample behind it. These say "do more of this".
 *  - EXPERIMENT: a group that looks promising on watch time but has too small a
 *    sample to trust. These say "we do not know yet; go find out".
 *
 * Every recommendation stores the numbers it came from, so the UI can show its
 * work instead of asking for faith.
 */

const MIN_LIFT_TO_RECOMMEND = 1.2;
const MIN_LIFT_TO_WARN = 0.8;

export type GeneratedRecommendation = {
  kind: RecommendationKind;
  title: string;
  rationale: string;
  confidence: Confidence;
  evidence: Record<string, unknown>;
  suggestedHook: string | null;
  suggestedFormat: ContentFormat | null;
  suggestedMinSeconds: number | null;
  suggestedMaxSeconds: number | null;
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  expectedLift: number | null;
  sampleSize: number;
};

export function generateRecommendations(
  facts: PostFact[],
): GeneratedRecommendation[] {
  if (facts.length === 0) return [];

  const reports = allReports(facts);
  const out: GeneratedRecommendation[] = [];
  const baseline = median(facts.map((f) => f.views));

  const byDimension = (dimension: DimensionReport["dimension"]) =>
    reports.find((report) => report.dimension === dimension);

  // --- Hooks --------------------------------------------------------------
  const hooks = byDimension("hook");
  const bestHook = pickBest(hooks);
  if (bestHook) {
    const exemplar = bestExemplar(facts, (fact) => classifyHook(fact.hook) === bestHook.key);
    out.push({
      kind: RecommendationKind.DOUBLE_DOWN,
      title: `Write more ${bestHook.label.toLowerCase()} openers`,
      rationale:
        `${bestHook.label} posts have a median of ${bestHook.medianViews.toLocaleString()} views against a project median of ` +
        `${Math.round(baseline).toLocaleString()} — ${formatLift(bestHook.liftVsMedian)}. ${bestHook.confidenceReason}`,
      confidence: bestHook.confidence,
      evidence: {
        dimension: "hook",
        group: bestHook.key,
        sampleSize: bestHook.sampleSize,
        groupMedianViews: bestHook.medianViews,
        projectMedianViews: Math.round(baseline),
        liftVsMedian: bestHook.liftVsMedian,
        meanCompletion: bestHook.meanCompletion,
        topPerformingHook: exemplar?.hook ?? null,
      },
      suggestedHook: exemplar?.hook ?? null,
      suggestedFormat: null,
      suggestedMinSeconds: null,
      suggestedMaxSeconds: null,
      windowStartMinute: null,
      windowEndMinute: null,
      expectedLift: bestHook.liftVsMedian,
      sampleSize: bestHook.sampleSize,
    });
  }

  // --- Format -------------------------------------------------------------
  const formats = byDimension("format");
  const bestFormat = pickBest(formats);
  if (bestFormat) {
    out.push({
      kind: RecommendationKind.FORMAT,
      title: `${bestFormat.label} is your strongest format`,
      rationale:
        `${bestFormat.sampleSize} ${bestFormat.label.toLowerCase()} posts hold a median of ` +
        `${bestFormat.medianViews.toLocaleString()} views (${formatLift(bestFormat.liftVsMedian)}) with ` +
        `${(bestFormat.meanCompletion * 100).toFixed(0)}% mean completion. ${bestFormat.confidenceReason}`,
      confidence: bestFormat.confidence,
      evidence: {
        dimension: "format",
        group: bestFormat.key,
        sampleSize: bestFormat.sampleSize,
        groupMedianViews: bestFormat.medianViews,
        projectMedianViews: Math.round(baseline),
        liftVsMedian: bestFormat.liftVsMedian,
        meanCompletion: bestFormat.meanCompletion,
      },
      suggestedHook: null,
      suggestedFormat: bestFormat.key as ContentFormat,
      suggestedMinSeconds: null,
      suggestedMaxSeconds: null,
      windowStartMinute: null,
      windowEndMinute: null,
      expectedLift: bestFormat.liftVsMedian,
      sampleSize: bestFormat.sampleSize,
    });
  }

  // --- Timing -------------------------------------------------------------
  const timing = byDimension("timing");
  const bestWindow = pickBest(timing);
  if (bestWindow) {
    const window = TIME_WINDOWS.find((entry) => entry.key === bestWindow.key);
    out.push({
      kind: RecommendationKind.TIMING,
      title: `Post in the ${bestWindow.label} window`,
      rationale:
        `Posts published ${bestWindow.label} have a median of ${bestWindow.medianViews.toLocaleString()} views ` +
        `(${formatLift(bestWindow.liftVsMedian)}) across ${bestWindow.sampleSize} posts. ${bestWindow.confidenceReason}`,
      confidence: bestWindow.confidence,
      evidence: {
        dimension: "timing",
        group: bestWindow.key,
        sampleSize: bestWindow.sampleSize,
        groupMedianViews: bestWindow.medianViews,
        projectMedianViews: Math.round(baseline),
        liftVsMedian: bestWindow.liftVsMedian,
      },
      suggestedHook: null,
      suggestedFormat: null,
      suggestedMinSeconds: null,
      suggestedMaxSeconds: null,
      windowStartMinute: window ? window.startHour * 60 : null,
      windowEndMinute: window ? window.endHour * 60 : null,
      expectedLift: bestWindow.liftVsMedian,
      sampleSize: bestWindow.sampleSize,
    });
  }

  // --- Length -------------------------------------------------------------
  const lengths = byDimension("length");
  const bestLength = pickBest(lengths);
  if (bestLength) {
    const [minSeconds, maxSeconds] = parseLengthBucket(bestLength.key);
    out.push({
      kind: RecommendationKind.DOUBLE_DOWN,
      title: `Target ${bestLength.label.toLowerCase()} runtimes`,
      rationale:
        `${bestLength.label} posts sit at ${bestLength.medianViews.toLocaleString()} median views ` +
        `(${formatLift(bestLength.liftVsMedian)}) with ${(bestLength.meanCompletion * 100).toFixed(0)}% completion. ${bestLength.confidenceReason}`,
      confidence: bestLength.confidence,
      evidence: {
        dimension: "length",
        group: bestLength.key,
        sampleSize: bestLength.sampleSize,
        groupMedianViews: bestLength.medianViews,
        projectMedianViews: Math.round(baseline),
        liftVsMedian: bestLength.liftVsMedian,
        meanCompletion: bestLength.meanCompletion,
      },
      suggestedHook: null,
      suggestedFormat: null,
      suggestedMinSeconds: minSeconds,
      suggestedMaxSeconds: maxSeconds,
      windowStartMinute: null,
      windowEndMinute: null,
      expectedLift: bestLength.liftVsMedian,
      sampleSize: bestLength.sampleSize,
    });
  }

  // --- CTA: judged on conversion, not views -------------------------------
  const ctas = byDimension("cta");
  const bestCta = ctas?.groups
    .filter((group) => group.sampleSize >= MIN_GROUP)
    .sort((a, b) => b.clickToConversion - a.clickToConversion)[0];
  if (bestCta && bestCta.clickToConversion > 0) {
    out.push({
      kind: RecommendationKind.CTA,
      title: `"${bestCta.label}" converts best`,
      rationale:
        `${bestCta.label} turns ${(bestCta.clickToConversion * 100).toFixed(1)}% of link clicks into conversions ` +
        `and drives ${bestCta.profileVisitRate.toFixed(1)} profile visits per 1,000 views, across ${bestCta.sampleSize} posts. ${bestCta.confidenceReason}`,
      confidence: bestCta.confidence,
      evidence: {
        dimension: "cta",
        group: bestCta.key,
        sampleSize: bestCta.sampleSize,
        clickToConversion: bestCta.clickToConversion,
        profileVisitRate: bestCta.profileVisitRate,
        liftVsMedian: bestCta.liftVsMedian,
      },
      suggestedHook: null,
      suggestedFormat: null,
      suggestedMinSeconds: null,
      suggestedMaxSeconds: null,
      windowStartMinute: null,
      windowEndMinute: null,
      expectedLift: null,
      sampleSize: bestCta.sampleSize,
    });
  }

  // --- Experiments: high watch time, not enough data ----------------------
  for (const report of reports) {
    const candidates = report.groups.filter(
      (group) =>
        group.sampleSize > 0 &&
        group.sampleSize < MIN_GROUP + 1 &&
        group.meanCompletion >= 0.6,
    );
    for (const candidate of candidates.slice(0, 1)) {
      out.push({
        kind: RecommendationKind.EXPERIMENT,
        title: `Test ${candidate.label.toLowerCase()} properly`,
        rationale:
          `${candidate.label} shows ${(candidate.meanCompletion * 100).toFixed(0)}% completion — the highest in this dimension — ` +
          `but only across ${candidate.sampleSize} post(s). That is a promising signal with no statistical weight behind it. ` +
          `Publish ${MIN_GROUP + 2 - candidate.sampleSize} more and it becomes a real finding either way.`,
        confidence: Confidence.LOW,
        evidence: {
          dimension: report.dimension,
          group: candidate.key,
          sampleSize: candidate.sampleSize,
          meanCompletion: candidate.meanCompletion,
          groupMedianViews: candidate.medianViews,
          projectMedianViews: Math.round(baseline),
          reason: "small_sample_high_watch_time",
        },
        suggestedHook: null,
        suggestedFormat:
          report.dimension === "format" ? (candidate.key as ContentFormat) : null,
        suggestedMinSeconds: null,
        suggestedMaxSeconds: null,
        windowStartMinute: null,
        windowEndMinute: null,
        expectedLift: null,
        sampleSize: candidate.sampleSize,
      });
    }
  }

  // --- Underperformers worth stopping -------------------------------------
  const worstHook = hooks?.groups
    .filter(
      (group) =>
        group.sampleSize >= MIN_GROUP + 1 &&
        group.liftVsMedian <= MIN_LIFT_TO_WARN &&
        group.confidence !== Confidence.LOW,
    )
    .sort((a, b) => a.liftVsMedian - b.liftVsMedian)[0];
  if (worstHook) {
    out.push({
      kind: RecommendationKind.EXPERIMENT,
      title: `Stop leading with ${worstHook.label.toLowerCase()}`,
      rationale:
        `${worstHook.label} openers land at ${worstHook.medianViews.toLocaleString()} median views, ` +
        `${formatLift(worstHook.liftVsMedian)} across ${worstHook.sampleSize} posts. ${worstHook.confidenceReason}`,
      confidence: worstHook.confidence,
      evidence: {
        dimension: "hook",
        group: worstHook.key,
        sampleSize: worstHook.sampleSize,
        groupMedianViews: worstHook.medianViews,
        projectMedianViews: Math.round(baseline),
        liftVsMedian: worstHook.liftVsMedian,
        reason: "underperforming",
      },
      suggestedHook: null,
      suggestedFormat: null,
      suggestedMinSeconds: null,
      suggestedMaxSeconds: null,
      windowStartMinute: null,
      windowEndMinute: null,
      expectedLift: worstHook.liftVsMedian,
      sampleSize: worstHook.sampleSize,
    });
  }

  return out;
}

function pickBest(report: DimensionReport | undefined): GroupPerformance | null {
  if (!report) return null;
  const eligible = report.groups.filter(
    (group) =>
      group.sampleSize >= MIN_GROUP &&
      group.liftVsMedian >= MIN_LIFT_TO_RECOMMEND &&
      group.confidence !== Confidence.LOW,
  );
  return eligible[0] ?? null;
}

/** The single best-performing post inside a group, used as a copy exemplar. */
function bestExemplar(
  facts: PostFact[],
  predicate: (fact: PostFact) => boolean,
): PostFact | null {
  const matching = facts.filter(predicate).sort((a, b) => b.views - a.views);
  return matching[0] ?? null;
}

function formatLift(lift: number): string {
  if (lift >= 1) return `${lift.toFixed(2)}x the median`;
  return `${Math.round((1 - lift) * 100)}% below the median`;
}

function parseLengthBucket(key: string): [number | null, number | null] {
  if (key === "60+") return [60, null];
  const [min, max] = key.split("-").map((part) => Number(part));
  return [Number.isFinite(min) ? min : null, Number.isFinite(max) ? max : null];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Recomputes a project's recommendations. Existing OPEN rows are marked
 * SUPERSEDED rather than deleted, so the history of what the system believed and
 * when stays auditable. Rows the operator accepted or dismissed are left alone.
 */
export async function refreshRecommendations(
  projectId: string,
): Promise<{ created: number; superseded: number }> {
  const facts = await loadPostFacts({ projectId });
  const generated = generateRecommendations(facts);

  const superseded = await prisma.recommendation.updateMany({
    where: { projectId, status: RecommendationStatus.OPEN },
    data: { status: RecommendationStatus.SUPERSEDED },
  });

  if (generated.length > 0) {
    await prisma.recommendation.createMany({
      data: generated.map((recommendation) => ({
        projectId,
        kind: recommendation.kind,
        title: recommendation.title,
        rationale: recommendation.rationale,
        confidence: recommendation.confidence,
        evidence: recommendation.evidence as object,
        suggestedHook: recommendation.suggestedHook,
        suggestedFormat: recommendation.suggestedFormat,
        suggestedMinSeconds: recommendation.suggestedMinSeconds,
        suggestedMaxSeconds: recommendation.suggestedMaxSeconds,
        windowStartMinute: recommendation.windowStartMinute,
        windowEndMinute: recommendation.windowEndMinute,
        expectedLift: recommendation.expectedLift,
        sampleSize: recommendation.sampleSize,
        status: RecommendationStatus.OPEN,
      })),
    });
  }

  await recordActivitySafe({
    action: activityActions.recommendationsUpdated,
    message: `Recommendation engine produced ${generated.length} suggestion(s) from ${facts.length} published post(s)`,
    projectId,
    actorType: ActorType.WORKER,
    metadata: { created: generated.length, superseded: superseded.count },
  });

  return { created: generated.length, superseded: superseded.count };
}
