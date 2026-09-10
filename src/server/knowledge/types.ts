import type { Platform } from "@/generated/prisma/enums";

/**
 * The seam through which non-account knowledge enters the system.
 *
 * Everything a provider returns becomes an `EvidenceSource` of type
 * `GLOBAL_PRIOR` or `EXTERNAL_EVIDENCE` — never `ACCOUNT_EVIDENCE`. That is
 * enforced at the registry, not left to each provider's good behaviour, because
 * the single most damaging thing this system could do is let a generic
 * assumption masquerade as something the brand demonstrated.
 *
 * Providers are deliberately thin: they answer "what does the outside world
 * suggest about this dimension", and the weighting layer decides how much that
 * is worth next to the account's own results.
 */

export type KnowledgeProviderKind =
  /** Ships with the system. Assumptions, not observations. */
  | "STATIC_PRIOR"
  /** Live platform trend data. */
  | "TREND_PROVIDER"
  /** Observations of specific competitor accounts. */
  | "COMPETITOR_PROVIDER"
  /** Published research about a platform. */
  | "PLATFORM_RESEARCH_PROVIDER"
  /** Aggregated benchmarks across accounts. */
  | "BENCHMARK_PROVIDER";

/** Context a provider may use to select or rank what it returns. */
export type KnowledgeQuery = {
  platform?: Platform | null;
  /** Creative dimension being asked about: "hook", "format", "length", ... */
  dimension?: string | null;
  /** KPI being optimised for. */
  objective?: string | null;
  industry?: string | null;
  /** Free-text brand description, for relevance filtering. */
  brandSummary?: string | null;
};

/**
 * One claim from outside this account.
 *
 * `effectSize` is optional and often absent for priors — a prior usually asserts
 * a direction ("shorter openers tend to hold attention") without a measured
 * magnitude, and pretending otherwise would inflate its weight.
 */
export type KnowledgeItem = {
  /** Stable within a provider, so re-running replaces rather than duplicates. */
  key: string;
  claim: string;
  dimension: string;
  groupKey: string;
  metric: string;
  effectSize?: number | null;
  /** 0..1. A prior should rarely assert more than moderate confidence. */
  confidence: number;
  platform?: Platform | null;
  objective?: string | null;
  /** Why this is believed, in one line. Shown in the provenance panel. */
  rationale: string;
  /** External evidence must carry a reference; priors need not. */
  reference?: string | null;
  /** External observations go stale. Null means no expiry. */
  expiresAt?: Date | null;
};

export type ContentKnowledgeProvider = {
  readonly name: string;
  readonly kind: KnowledgeProviderKind;
  /**
   * Which evidence class this provider's output becomes. A provider may only
   * ever declare GLOBAL_PRIOR or EXTERNAL_EVIDENCE.
   */
  readonly evidenceClass: "GLOBAL_PRIOR" | "EXTERNAL_EVIDENCE";
  readonly enabled: boolean;
  /** One line explaining what this provider knows and what it does not. */
  readonly description: string;

  query(input: KnowledgeQuery): Promise<KnowledgeItem[]>;
};
