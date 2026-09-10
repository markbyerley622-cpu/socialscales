import { EvidenceType } from "@/generated/prisma/enums";

/**
 * How evidence of different kinds is weighed against evidence of other kinds.
 *
 * The rule this module exists to enforce: **provenance is not a ranking**. A
 * global prior does not lose to account evidence because it is a prior; it loses
 * when the account evidence is actually stronger — more samples, a larger
 * effect, more recent, better aligned to the objective. Two flattering posts
 * must not outrank a well-evidenced external benchmark, and this is where that
 * is decided.
 *
 * There is deliberately no fixed blend such as "80% account / 20% prior". The
 * weight of every item is computed from its own measurable properties:
 *
 *     weight = inferentialStrength × relevance × recency × sampleAdequacy
 *              × effectMagnitude × confidence
 *
 * Each factor is 0..1, so a weakness anywhere pulls the whole item down and no
 * single factor can rescue an otherwise poor observation.
 */

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How much causal weight the *method of observation* can bear, independent of
 * how good the numbers are.
 *
 * This is epistemics, not preference. A controlled test isolates a variable, so
 * it can support a causal claim. Observing your own account cannot separate the
 * hook from the topic, the day or the algorithm, but it is at least *your*
 * audience. Someone else's results are a weaker signal about your audience
 * again. A shipped prior is a starting assumption backed by no observation of
 * anyone in particular.
 *
 * These are ceilings, not scores: an experiment with four samples still scores
 * badly, because `sampleAdequacy` will be low.
 */
export const INFERENTIAL_STRENGTH: Record<EvidenceType, number> = {
  EXPERIMENT_EVIDENCE: 1.0,
  ACCOUNT_EVIDENCE: 0.7,
  EXTERNAL_EVIDENCE: 0.45,
  GLOBAL_PRIOR: 0.25,
};

/**
 * How fast each kind of evidence stops describing the present, in days.
 *
 * Account results age as a platform's distribution changes. Market observations
 * age faster still. A controlled result ages more slowly, because it isolated a
 * mechanism rather than a moment. Priors are timeless by construction — they are
 * assumptions, not observations, so there is nothing to go stale.
 */
export const RECENCY_HALF_LIFE_DAYS: Record<EvidenceType, number | null> = {
  EXPERIMENT_EVIDENCE: 180,
  ACCOUNT_EVIDENCE: 90,
  EXTERNAL_EVIDENCE: 30,
  GLOBAL_PRIOR: null,
};

/**
 * Sample smoothing constant, in observations.
 *
 * `n / (n + K)` rises steeply then flattens: 1 sample scores 0.14, 3 scores
 * 0.33, 6 scores 0.5, 12 scores 0.67, 24 scores 0.8. Chosen so that a couple of
 * lucky posts cannot dominate, without demanding sample sizes a real account
 * will never reach on a single creative dimension.
 */
export const SAMPLE_SMOOTHING = 6;

/**
 * Effect size, in relative terms, at which an observation counts as fully
 * meaningful. Below this it scales linearly; a 5% difference is real but small,
 * and should weigh accordingly.
 */
export const FULL_EFFECT_THRESHOLD = 0.3;

/** A prior asserts a direction but no measured magnitude; treat it as modest. */
const PRIOR_ASSUMED_EFFECT = 0.15;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type WeighableEvidence = {
  id: string;
  type: EvidenceType;
  /** 0..1 as asserted by whatever produced it. */
  confidence: number;
  sampleSize: number;
  /** Relative to baseline. Sign carries direction; magnitude is what weighs. */
  effectSize: number | null;
  observedAt: Date;
  expiresAt?: Date | null;
  /** Which creative/distribution dimension it speaks to. */
  dimension?: string | null;
  groupKey?: string | null;
  /** KPI it speaks to, when objective-specific. */
  objective?: string | null;
};

export type WeighingContext = {
  now?: Date;
  /** The KPI currently being optimised for, if any. */
  objective?: string | null;
  /** The dimension the question is about, e.g. "hook". */
  dimension?: string | null;
  groupKey?: string | null;
};

export type EvidenceWeight = {
  id: string;
  type: EvidenceType;
  weight: number;
  factors: {
    inferentialStrength: number;
    relevance: number;
    recency: number;
    sampleAdequacy: number;
    effectMagnitude: number;
    confidence: number;
  };
  /** Plain-language reason the weight came out where it did. */
  explanation: string;
};

// ---------------------------------------------------------------------------
// Factors
// ---------------------------------------------------------------------------

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Does this observation answer the question being asked?
 *
 * Multiplicative: evidence about the wrong dimension is nearly worthless here
 * however good it is, but evidence with no dimension recorded is treated as
 * merely unfocused rather than irrelevant.
 */
export function relevance(
  evidence: WeighableEvidence,
  context: WeighingContext,
): number {
  let score = 1;

  if (context.dimension) {
    if (!evidence.dimension) score *= 0.5;
    else if (evidence.dimension !== context.dimension) score *= 0.1;
  }

  if (context.groupKey && evidence.groupKey) {
    if (evidence.groupKey !== context.groupKey) score *= 0.2;
  }

  if (context.objective) {
    // Evidence about a different KPI still says something, but less.
    if (evidence.objective && evidence.objective !== context.objective) {
      score *= 0.6;
    }
  }

  return clamp01(score);
}

/** Exponential decay on the type's half-life. Priors do not decay. */
export function recency(evidence: WeighableEvidence, now: Date): number {
  if (evidence.expiresAt && evidence.expiresAt.getTime() <= now.getTime()) {
    return 0;
  }
  const halfLife = RECENCY_HALF_LIFE_DAYS[evidence.type];
  if (halfLife === null) return 1;

  const ageDays = Math.max(
    0,
    (now.getTime() - evidence.observedAt.getTime()) / 86_400_000,
  );
  return clamp01(Math.pow(0.5, ageDays / halfLife));
}

/** Saturating in sample size; see SAMPLE_SMOOTHING. */
export function sampleAdequacy(evidence: WeighableEvidence): number {
  // A prior is not an observation, so sample size is not the right question.
  // It is capped by its inferential strength instead.
  if (evidence.type === EvidenceType.GLOBAL_PRIOR) return 1;

  const n = Math.max(0, evidence.sampleSize);
  return n / (n + SAMPLE_SMOOTHING);
}

/** Magnitude only. A large negative effect is as informative as a positive one. */
export function effectMagnitude(evidence: WeighableEvidence): number {
  if (evidence.effectSize === null) {
    return evidence.type === EvidenceType.GLOBAL_PRIOR
      ? PRIOR_ASSUMED_EFFECT / FULL_EFFECT_THRESHOLD
      : 0.5;
  }
  return clamp01(Math.abs(evidence.effectSize) / FULL_EFFECT_THRESHOLD);
}

// ---------------------------------------------------------------------------
// Weighing
// ---------------------------------------------------------------------------

export function weighEvidence(
  evidence: WeighableEvidence,
  context: WeighingContext = {},
): EvidenceWeight {
  const now = context.now ?? new Date();

  const factors = {
    inferentialStrength: INFERENTIAL_STRENGTH[evidence.type],
    relevance: relevance(evidence, context),
    recency: recency(evidence, now),
    sampleAdequacy: sampleAdequacy(evidence),
    effectMagnitude: effectMagnitude(evidence),
    confidence: clamp01(evidence.confidence),
  };

  const weight =
    factors.inferentialStrength *
    factors.relevance *
    factors.recency *
    factors.sampleAdequacy *
    factors.effectMagnitude *
    factors.confidence;

  return {
    id: evidence.id,
    type: evidence.type,
    weight: Math.round(weight * 10_000) / 10_000,
    factors,
    explanation: explain(evidence, factors),
  };
}

/** Names the factor doing the most damage, which is what an operator needs. */
function explain(
  evidence: WeighableEvidence,
  factors: EvidenceWeight["factors"],
): string {
  const label: Record<EvidenceType, string> = {
    ACCOUNT_EVIDENCE: "this account's own results",
    EXPERIMENT_EVIDENCE: "a controlled test on this account",
    EXTERNAL_EVIDENCE: "outside observation",
    GLOBAL_PRIOR: "a general prior, not observed on this account",
  };

  const weakest = (
    Object.entries(factors) as Array<[keyof EvidenceWeight["factors"], number]>
  )
    .filter(([key]) => key !== "inferentialStrength")
    .sort((a, b) => a[1] - b[1])[0];

  const reason: Record<string, string> = {
    relevance: "it is about a different dimension or objective",
    recency: "it is old enough to describe a different period",
    sampleAdequacy: `it rests on ${evidence.sampleSize} observation${evidence.sampleSize === 1 ? "" : "s"}`,
    effectMagnitude: "the measured difference is small",
    confidence: "its own stated confidence is low",
  };

  return weakest[1] >= 0.75
    ? `From ${label[evidence.type]}; nothing materially weakens it.`
    : `From ${label[evidence.type]}, discounted because ${reason[weakest[0]] ?? "of its inputs"}.`;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type ResolvedClaim = {
  /** Net signed score. Positive supports the direction, negative opposes it. */
  score: number;
  /** Sum of all weights considered, supporting and contradicting. */
  totalWeight: number;
  supporting: EvidenceWeight[];
  contradicting: EvidenceWeight[];
  /** Which evidence classes actually contributed anything. */
  classesUsed: EvidenceType[];
  /** True when nothing but priors is behind this. */
  priorOnly: boolean;
  /**
   * 0..1. High only when meaningful weight is present AND it is not badly
   * contradicted AND it does not rest on priors alone.
   */
  strength: number;
};

/**
 * Combines a set of weighted observations into one answer.
 *
 * Contradicting evidence subtracts rather than being filtered out — a claim with
 * strong evidence on both sides should read as contested, not as settled in
 * favour of whichever side was counted first.
 */
export function resolveClaim(
  items: Array<{ evidence: WeighableEvidence; contradicts?: boolean }>,
  context: WeighingContext = {},
): ResolvedClaim {
  const supporting: EvidenceWeight[] = [];
  const contradicting: EvidenceWeight[] = [];

  for (const item of items) {
    const weighed = weighEvidence(item.evidence, context);
    if (item.contradicts) contradicting.push(weighed);
    else supporting.push(weighed);
  }

  const support = supporting.reduce((sum, item) => sum + item.weight, 0);
  const against = contradicting.reduce((sum, item) => sum + item.weight, 0);
  const totalWeight = support + against;

  const contributed = [...supporting, ...contradicting].filter(
    (item) => item.weight > 0,
  );
  const classesUsed = [...new Set(contributed.map((item) => item.type))];
  const priorOnly =
    classesUsed.length > 0 &&
    classesUsed.every((type) => type === EvidenceType.GLOBAL_PRIOR);

  // Agreement: how one-sided the evidence is, 0 when evenly split.
  const agreement = totalWeight > 0 ? Math.abs(support - against) / totalWeight : 0;
  // Saturating in absolute weight, so one strong item is not "certain".
  const mass = totalWeight / (totalWeight + 1);

  const strength = clamp01(agreement * mass * (priorOnly ? 0.5 : 1));

  return {
    score: Math.round((support - against) * 10_000) / 10_000,
    totalWeight: Math.round(totalWeight * 10_000) / 10_000,
    supporting: supporting.sort((a, b) => b.weight - a.weight),
    contradicting: contradicting.sort((a, b) => b.weight - a.weight),
    classesUsed,
    priorOnly,
    strength: Math.round(strength * 10_000) / 10_000,
  };
}
