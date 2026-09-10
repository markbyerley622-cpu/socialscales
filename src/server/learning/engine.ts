import { Confidence, type ContentFormat } from "@/generated/prisma/enums";
import { mean, median, type PostFact } from "@/server/analytics/aggregate";

/**
 * The learning engine.
 *
 * It answers one question per dimension: "given what this account has actually
 * published, which choices outperformed this account's own median?"
 *
 * Three rules keep it honest:
 *  1. Comparisons are always against the project's own median, never an industry
 *     benchmark we made up.
 *  2. Confidence is a function of sample size and effect size, stated in the
 *     open. Below MIN_DATASET posts, nothing gets HIGH confidence at all.
 *  3. Nothing here predicts virality. It reports what happened and how strongly.
 */

/** No dimension may claim HIGH confidence until the project has this many posts. */
export const MIN_DATASET = 12;
/** Groups smaller than this are reported but never recommended. */
export const MIN_GROUP = 3;

export const CONFIDENCE_RULES = {
  high: { minSample: 8, minEffect: 0.25 },
  medium: { minSample: 4, minEffect: 0.15 },
} as const;

export type GroupPerformance = {
  key: string;
  label: string;
  sampleSize: number;
  medianViews: number;
  meanCompletion: number;
  meanEngagement: number;
  /** Profile visits per thousand views. */
  profileVisitRate: number;
  /** Conversions per link click, 0 when there were no clicks. */
  clickToConversion: number;
  /** Group median views ÷ project median views. 1.0 means "exactly typical". */
  liftVsMedian: number;
  confidence: Confidence;
  /** Plain-language statement of why this confidence level was assigned. */
  confidenceReason: string;
};

export type DimensionReport = {
  dimension: "hook" | "format" | "timing" | "length" | "cta";
  label: string;
  /** The project median these groups are compared against. */
  baselineMedianViews: number;
  datasetSize: number;
  groups: GroupPerformance[];
};

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

export type HookPattern =
  | "question"
  | "pov"
  | "numeric"
  | "contrarian"
  | "problem_solution"
  | "direct";

/**
 * Buckets a hook into a reusable pattern. Individual hooks are all unique, so
 * grouping by exact text would give every group a sample size of one.
 */
export function classifyHook(hook: string): HookPattern {
  const text = hook.toLowerCase();
  if (/^pov\b|^pov:/.test(text)) return "pov";
  if (/\b(instead of|replaced|the hard way|stop doing|still doing)\b/.test(text)) {
    return "problem_solution";
  }
  if (/\b(nobody|no one|never|stop|don't|doesn't|wrong)\b/.test(text)) {
    return "contrarian";
  }
  if (text.includes("?")) return "question";
  if (/\d/.test(text)) return "numeric";
  return "direct";
}

const HOOK_LABELS: Record<HookPattern, string> = {
  question: "Question hook",
  pov: "POV framing",
  numeric: "Number-led hook",
  contrarian: "Contrarian / negation",
  problem_solution: "Problem → solution",
  direct: "Direct statement",
};

export const LENGTH_BUCKETS: Array<{ key: string; label: string; max: number }> = [
  { key: "0-15", label: "Under 15s", max: 15 },
  { key: "16-25", label: "16–25s", max: 25 },
  { key: "26-35", label: "26–35s", max: 35 },
  { key: "36-45", label: "36–45s", max: 45 },
  { key: "46-60", label: "46–60s", max: 60 },
  { key: "60+", label: "Over 60s", max: Number.POSITIVE_INFINITY },
];

export function classifyLength(durationSeconds: number | null): string | null {
  if (durationSeconds === null) return null;
  return (
    LENGTH_BUCKETS.find((bucket) => durationSeconds <= bucket.max)?.key ?? "60+"
  );
}

export const TIME_WINDOWS: Array<{
  key: string;
  label: string;
  startHour: number;
  endHour: number;
}> = [
  { key: "early", label: "6–9 AM", startHour: 6, endHour: 9 },
  { key: "morning", label: "9 AM–12 PM", startHour: 9, endHour: 12 },
  { key: "midday", label: "12–3 PM", startHour: 12, endHour: 15 },
  { key: "afternoon", label: "3–6 PM", startHour: 15, endHour: 18 },
  { key: "evening", label: "6–9 PM", startHour: 18, endHour: 21 },
  { key: "night", label: "9 PM–12 AM", startHour: 21, endHour: 24 },
  { key: "overnight", label: "12–6 AM", startHour: 0, endHour: 6 },
];

export function classifyHour(hour: number): string {
  return (
    TIME_WINDOWS.find(
      (window) => hour >= window.startHour && hour < window.endHour,
    )?.key ?? "overnight"
  );
}

const FORMAT_LABELS: Record<string, string> = {
  TALKING_HEAD: "Talking head",
  SCREEN_RECORDING: "Screen recording",
  TUTORIAL: "Tutorial",
  STORY: "Story",
  COMPARISON: "Comparison",
  LIST: "List",
  REACTION: "Reaction",
  BUILD_IN_PUBLIC: "Build in public",
  UNKNOWN: "Unclassified",
};

/** Normalises a CTA to its action so different wordings group together. */
export function classifyCta(cta: string): string {
  const text = cta.toLowerCase();
  if (/\bcomment\b/.test(text)) return "comment";
  if (/\b(dm|message)\b/.test(text)) return "dm";
  if (/\blink in bio\b/.test(text)) return "link_in_bio";
  if (/\b(join|waitlist|beta)\b/.test(text)) return "join";
  if (/\b(try|start|free)\b/.test(text)) return "try";
  if (/\b(book|call|demo)\b/.test(text)) return "book";
  if (!text.trim()) return "none";
  return "other";
}

const CTA_LABELS: Record<string, string> = {
  comment: 'Comment-to-receive',
  dm: "DM prompt",
  link_in_bio: "Link in bio",
  join: "Join beta / waitlist",
  try: "Try it free",
  book: "Book a call",
  none: "No CTA",
  other: "Other CTA",
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Assigns confidence from sample size and effect size together. A large effect
 * on three posts is not a finding, and a 2% difference on fifty posts is not
 * actionable — both land on LOW.
 */
export function assignConfidence(input: {
  sampleSize: number;
  liftVsMedian: number;
  datasetSize: number;
}): { confidence: Confidence; reason: string } {
  const effect = Math.abs(input.liftVsMedian - 1);
  const effectPct = Math.round(effect * 100);

  if (input.datasetSize < MIN_DATASET) {
    return {
      confidence: Confidence.LOW,
      reason: `Only ${input.datasetSize} published posts in this project; at least ${MIN_DATASET} are needed before any pattern is treated as reliable.`,
    };
  }
  if (
    input.sampleSize >= CONFIDENCE_RULES.high.minSample &&
    effect >= CONFIDENCE_RULES.high.minEffect
  ) {
    return {
      confidence: Confidence.HIGH,
      reason: `${input.sampleSize} posts, ${effectPct}% away from this project's median — above the ${CONFIDENCE_RULES.high.minSample}-post and ${Math.round(CONFIDENCE_RULES.high.minEffect * 100)}% thresholds.`,
    };
  }
  if (
    input.sampleSize >= CONFIDENCE_RULES.medium.minSample &&
    effect >= CONFIDENCE_RULES.medium.minEffect
  ) {
    return {
      confidence: Confidence.MEDIUM,
      reason: `${input.sampleSize} posts, ${effectPct}% away from median — enough to act on, not enough to be sure.`,
    };
  }
  return {
    confidence: Confidence.LOW,
    reason:
      input.sampleSize < CONFIDENCE_RULES.medium.minSample
        ? `Only ${input.sampleSize} post(s) in this group.`
        : `Effect is ${effectPct}%, too small to separate from noise.`,
  };
}

function summariseGroup(input: {
  key: string;
  label: string;
  facts: PostFact[];
  baselineMedianViews: number;
  datasetSize: number;
}): GroupPerformance {
  const views = input.facts.map((f) => f.views);
  const groupMedian = median(views);
  const lift =
    input.baselineMedianViews > 0 ? groupMedian / input.baselineMedianViews : 0;
  const { confidence, reason } = assignConfidence({
    sampleSize: input.facts.length,
    liftVsMedian: lift,
    datasetSize: input.datasetSize,
  });

  const totalClicks = input.facts.reduce((sum, f) => sum + f.linkClicks, 0);
  const totalConversions = input.facts.reduce((sum, f) => sum + f.conversions, 0);
  const totalViews = input.facts.reduce((sum, f) => sum + f.views, 0);
  const totalVisits = input.facts.reduce((sum, f) => sum + f.profileVisits, 0);

  return {
    key: input.key,
    label: input.label,
    sampleSize: input.facts.length,
    medianViews: Math.round(groupMedian),
    meanCompletion: round(mean(input.facts.map((f) => f.completionRate)), 4),
    meanEngagement: round(mean(input.facts.map((f) => f.engagementRate)), 4),
    profileVisitRate: totalViews > 0 ? round((totalVisits / totalViews) * 1000, 2) : 0,
    clickToConversion: totalClicks > 0 ? round(totalConversions / totalClicks, 4) : 0,
    liftVsMedian: round(lift, 3),
    confidence,
    confidenceReason: reason,
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Dimension reports
// ---------------------------------------------------------------------------

function buildReport(input: {
  dimension: DimensionReport["dimension"];
  label: string;
  facts: PostFact[];
  keyOf: (fact: PostFact) => string | null;
  labelOf: (key: string) => string;
}): DimensionReport {
  const baseline = median(input.facts.map((f) => f.views));
  const grouped = new Map<string, PostFact[]>();

  for (const fact of input.facts) {
    const key = input.keyOf(fact);
    if (key === null) continue;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(fact);
    else grouped.set(key, [fact]);
  }

  const groups = [...grouped.entries()]
    .map(([key, facts]) =>
      summariseGroup({
        key,
        label: input.labelOf(key),
        facts,
        baselineMedianViews: baseline,
        datasetSize: input.facts.length,
      }),
    )
    .sort((a, b) => b.liftVsMedian - a.liftVsMedian);

  return {
    dimension: input.dimension,
    label: input.label,
    baselineMedianViews: Math.round(baseline),
    datasetSize: input.facts.length,
    groups,
  };
}

export function hookReport(facts: PostFact[]): DimensionReport {
  return buildReport({
    dimension: "hook",
    label: "Hook pattern",
    facts,
    keyOf: (fact) => classifyHook(fact.hook),
    labelOf: (key) => HOOK_LABELS[key as HookPattern] ?? key,
  });
}

export function formatReport(facts: PostFact[]): DimensionReport {
  return buildReport({
    dimension: "format",
    label: "Format",
    facts,
    keyOf: (fact) => (fact.format as ContentFormat | null) ?? null,
    labelOf: (key) => FORMAT_LABELS[key] ?? key,
  });
}

export function timingReport(facts: PostFact[]): DimensionReport {
  return buildReport({
    dimension: "timing",
    label: "Posting window",
    facts,
    keyOf: (fact) => classifyHour(fact.publishedHour),
    labelOf: (key) =>
      TIME_WINDOWS.find((window) => window.key === key)?.label ?? key,
  });
}

export function lengthReport(facts: PostFact[]): DimensionReport {
  return buildReport({
    dimension: "length",
    label: "Runtime",
    facts,
    keyOf: (fact) => classifyLength(fact.durationSeconds),
    labelOf: (key) =>
      LENGTH_BUCKETS.find((bucket) => bucket.key === key)?.label ?? key,
  });
}

export function ctaReport(facts: PostFact[]): DimensionReport {
  return buildReport({
    dimension: "cta",
    label: "Call to action",
    facts,
    keyOf: (fact) => classifyCta(fact.cta),
    labelOf: (key) => CTA_LABELS[key] ?? key,
  });
}

export function allReports(facts: PostFact[]): DimensionReport[] {
  return [
    hookReport(facts),
    formatReport(facts),
    timingReport(facts),
    lengthReport(facts),
    ctaReport(facts),
  ];
}

// ---------------------------------------------------------------------------
// Performance estimate (explicitly not a "viral score")
// ---------------------------------------------------------------------------

export type PerformanceEstimate = {
  /** Expected views, as a multiple of the project's median. */
  expectedLift: number;
  expectedViews: number;
  confidence: Confidence;
  /** The dimension findings this estimate was assembled from. */
  basis: Array<{
    dimension: string;
    group: string;
    lift: number;
    sampleSize: number;
    confidence: Confidence;
  }>;
  explanation: string;
};

/**
 * Estimates how a proposed combination is likely to do, based only on how those
 * same choices performed for this account before.
 *
 * The estimate is the product of the per-dimension lifts, but only dimensions at
 * MEDIUM or better contribute — a LOW-confidence dimension is reported in the
 * basis with a lift of 1.0 so it visibly does not move the number. The overall
 * confidence is the weakest contributing dimension, never the strongest.
 */
export function estimatePerformance(input: {
  facts: PostFact[];
  hook: string;
  format: ContentFormat | null;
  durationSeconds: number | null;
  hour: number;
  cta: string;
}): PerformanceEstimate {
  const baseline = median(input.facts.map((f) => f.views));
  const reports = allReports(input.facts);

  const wanted: Array<{ dimension: string; key: string | null }> = [
    { dimension: "hook", key: classifyHook(input.hook) },
    { dimension: "format", key: input.format },
    { dimension: "length", key: classifyLength(input.durationSeconds) },
    { dimension: "timing", key: classifyHour(input.hour) },
    { dimension: "cta", key: classifyCta(input.cta) },
  ];

  const basis: PerformanceEstimate["basis"] = [];
  let lift = 1;
  let weakest: Confidence = Confidence.HIGH;
  let contributors = 0;

  for (const want of wanted) {
    if (want.key === null) continue;
    const report = reports.find((r) => r.dimension === want.dimension);
    const group = report?.groups.find((g) => g.key === want.key);
    if (!group) continue;

    const counts =
      group.confidence === Confidence.HIGH || group.confidence === Confidence.MEDIUM;
    if (counts) {
      // Dampened: a 3x group lift does not multiply the estimate by 3.
      lift *= 1 + (group.liftVsMedian - 1) * 0.5;
      contributors += 1;
      if (rank(group.confidence) < rank(weakest)) weakest = group.confidence;
    }

    basis.push({
      dimension: report?.label ?? want.dimension,
      group: group.label,
      lift: counts ? group.liftVsMedian : 1,
      sampleSize: group.sampleSize,
      confidence: group.confidence,
    });
  }

  const confidence = contributors === 0 ? Confidence.LOW : weakest;
  const explanation =
    contributors === 0
      ? `Not enough history yet: no dimension of this combination has reached ${CONFIDENCE_RULES.medium.minSample} comparable posts. Publish more and this estimate becomes usable.`
      : `Built from ${contributors} dimension(s) with at least ${CONFIDENCE_RULES.medium.minSample} comparable posts each, measured against this project's median of ${Math.round(baseline).toLocaleString()} views. Group lifts are halved to avoid compounding small samples into a large claim.`;

  return {
    expectedLift: round(lift, 2),
    expectedViews: Math.round(baseline * lift),
    confidence,
    basis,
    explanation,
  };
}

function rank(confidence: Confidence): number {
  return confidence === Confidence.HIGH ? 3 : confidence === Confidence.MEDIUM ? 2 : 1;
}
