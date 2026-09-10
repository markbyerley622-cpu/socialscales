import { prisma } from "@/server/db";
import { EvidenceType } from "@/generated/prisma/enums";
import { findEvidence, toWeighable } from "@/server/intelligence/evidence";
import { coldStartState } from "@/server/intelligence/learning";
import { resolveClaim, type WeighingContext } from "@/server/intelligence/weighting";

/**
 * Everything the strategy engine is allowed to reason from, assembled once.
 *
 * This is the typed input to the `strategy-draft` prompt, so it is also what
 * gets stored on the `AIJob` — which means a strategy can be re-derived later
 * from exactly the picture the system had at the time, not from today's data.
 *
 * Two rules shape it:
 *
 *  - Every evidence-backed option carries its own `evidenceIds`, so the strategy
 *    can only cite things that exist. A model that invents a citation fails
 *    validation rather than producing a plausible-looking lie.
 *  - The account's own state is stated plainly, including when there is nothing
 *    in it. A cold-start account gets a strategy built from priors, labelled as
 *    built from priors.
 */

/** The creative and distribution dimensions a strategy makes choices about. */
export const STRATEGY_DIMENSIONS = [
  "hook",
  "format",
  "length",
  "cta",
  "timing",
  "cadence",
  "distribution",
] as const;

export type StrategyDimension = (typeof STRATEGY_DIMENSIONS)[number];

export type DimensionOption = {
  groupKey: string;
  /** The clearest claim among the evidence behind this option. */
  claim: string;
  /** Net signed score. Negative means the evidence argues against it. */
  score: number;
  /** 0..1 confidence in the direction, after contradiction and provenance. */
  strength: number;
  /** True when nothing but shipped priors supports it. */
  priorOnly: boolean;
  /** Which classes contributed. Never collapsed into a single number. */
  classes: EvidenceType[];
  /** The evidence a strategy may cite for this option, and nothing else. */
  evidenceIds: string[];
};

export type DimensionDigest = {
  dimension: StrategyDimension;
  options: DimensionOption[];
  /** One line an operator can read without expanding anything. */
  headline: string;
};

export type ObjectiveContext = {
  id: string;
  kind: string;
  kpi: string;
  priority: number;
  targetValue: number | null;
  /** Share of total optimisation pull, 0..1. Normalised here, not stored. */
  normalisedWeight: number;
  attributionLimitations: string | null;
};

export type AudienceContext = {
  id: string;
  name: string;
  description: string | null;
  awarenessStage: string;
  priority: number;
  pains: string[];
  desires: string[];
  objections: string[];
  motivations: string[];
};

export type AccountState = {
  cold: boolean;
  reason: string;
  accountObservations: number;
  experiments: number;
  publishedPosts: number;
  /** Publications the platform confirmed, as opposed to attempts we made. */
  verifiedPublications: number;
  connectedPlatforms: string[];
  /** True when every analytics number on file is simulated. */
  analyticsAreSimulated: boolean;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
};

export type StrategyContext = {
  projectId: string;
  projectName: string;
  brand: {
    audience: string;
    tone: string;
    valueProp: string;
    primaryCta: string;
    website: string | null;
    industry: string | null;
    productsServices: string[];
    geography: string | null;
    competitors: string[];
    differentiators: string[];
    prohibitedTopics: string[];
    bannedPhrases: string[];
    visualStyle: string | null;
  };
  objectives: ObjectiveContext[];
  audiences: AudienceContext[];
  pillars: Array<{ slug: string; name: string; description: string | null }>;
  accountState: AccountState;
  dimensions: DimensionDigest[];
  /** Every id a strategy is permitted to cite. */
  citableEvidenceIds: string[];
};

export async function buildStrategyContext(input: {
  workspaceId: string;
  projectId: string;
  now?: Date;
}): Promise<StrategyContext> {
  const now = input.now ?? new Date();

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: input.projectId },
    include: {
      brand: true,
      objectives: { where: { active: true }, orderBy: { priority: "asc" } },
      audiences: { orderBy: { priority: "asc" } },
      pillars: { orderBy: { name: "asc" } },
      accounts: true,
    },
  });

  const [cold, publishedPosts, verifiedPublications, analyticsSources, bounds] =
    await Promise.all([
      coldStartState({ workspaceId: input.workspaceId, projectId: input.projectId }),
      prisma.postPlatform.count({
        where: { post: { projectId: input.projectId }, publishedAt: { not: null } },
      }),
      prisma.postPlatform.count({
        where: { post: { projectId: input.projectId }, verifiedAt: { not: null } },
      }),
      prisma.analyticsSnapshot.groupBy({
        by: ["source"],
        where: { postPlatform: { post: { projectId: input.projectId } } },
        _count: { _all: true },
      }),
      publishBounds(input.projectId),
    ]);

  const evidence = await findEvidence({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    limit: 500,
  });

  const totalPull = project.objectives.reduce(
    (sum, objective) => sum + Math.max(0, objective.optimizationWeight),
    0,
  );
  const objectives: ObjectiveContext[] = project.objectives.map((objective) => ({
    id: objective.id,
    kind: objective.kind,
    kpi: objective.kpi,
    priority: objective.priority,
    targetValue: objective.targetValue,
    normalisedWeight:
      totalPull > 0 ? Math.max(0, objective.optimizationWeight) / totalPull : 0,
    attributionLimitations: objective.attributionLimitations,
  }));

  // The objective actually being optimised for shapes relevance scoring, so the
  // same evidence weighs differently for a reach goal than for a leads goal.
  const primaryKpi = objectives[0]?.kpi ?? null;

  const dimensions = STRATEGY_DIMENSIONS.map((dimension) =>
    digestDimension(dimension, evidence, { now, objective: primaryKpi, dimension }),
  );

  const citableEvidenceIds = [
    ...new Set(dimensions.flatMap((digest) => digest.options.flatMap((o) => o.evidenceIds))),
  ];

  return {
    projectId: project.id,
    projectName: project.name,
    brand: {
      audience: project.brand?.audience ?? "not stated",
      tone: project.brand?.tone ?? "not stated",
      valueProp: project.brand?.valueProp ?? "not stated",
      primaryCta: project.brand?.primaryCta ?? "not stated",
      website: project.brand?.website ?? null,
      industry: project.brand?.industry ?? null,
      productsServices: project.brand?.productsServices ?? [],
      geography: project.brand?.geography ?? null,
      competitors: project.brand?.competitors ?? [],
      differentiators: project.brand?.differentiators ?? [],
      prohibitedTopics: project.brand?.prohibitedTopics ?? [],
      bannedPhrases: project.brand?.bannedPhrases ?? [],
      visualStyle: project.brand?.visualStyle ?? null,
    },
    objectives,
    audiences: project.audiences.map((audience) => ({
      id: audience.id,
      name: audience.name,
      description: audience.description,
      awarenessStage: audience.awarenessStage,
      priority: audience.priority,
      pains: audience.pains,
      desires: audience.desires,
      objections: audience.objections,
      motivations: audience.motivations,
    })),
    pillars: project.pillars.map((pillar) => ({
      slug: pillar.slug,
      name: pillar.name,
      description: pillar.description,
    })),
    accountState: {
      cold: cold.cold,
      reason: cold.reason,
      accountObservations: cold.accountObservations,
      experiments: cold.experiments,
      publishedPosts,
      verifiedPublications,
      connectedPlatforms: [
        ...new Set(
          project.accounts
            .filter((account) => account.status === "CONNECTED")
            .map((account) => account.platform),
        ),
      ],
      analyticsAreSimulated:
        analyticsSources.length > 0 &&
        analyticsSources.every((row) => row.source === "SIMULATED"),
      firstPublishedAt: bounds.first?.toISOString() ?? null,
      lastPublishedAt: bounds.last?.toISOString() ?? null,
    },
    dimensions,
    citableEvidenceIds,
  };
}

/**
 * Ranks the options within one dimension.
 *
 * Evidence is grouped by `groupKey` — "problem_solution" hooks against "numeric"
 * hooks — and each group is resolved independently, so a well-evidenced option
 * and a prior-only option sit side by side with their provenance intact rather
 * than being averaged into one number.
 */
export function digestDimension(
  dimension: StrategyDimension,
  evidence: Array<Parameters<typeof toWeighable>[0] & { claim: string; groupKey: string | null }>,
  context: WeighingContext,
): DimensionDigest {
  const relevant = evidence.filter((row) => row.dimension === dimension);
  const groups = new Map<string, typeof relevant>();
  for (const row of relevant) {
    const key = row.groupKey ?? "unspecified";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const options: DimensionOption[] = [...groups.entries()]
    .map(([groupKey, rows]) => {
      const resolved = resolveClaim(
        rows.map((row) => ({ evidence: toWeighable(row) })),
        { ...context, groupKey },
      );
      return {
        groupKey,
        // The claim from the heaviest piece of evidence, so the sentence shown
        // matches the thing that actually carried the option.
        claim: heaviestClaim(rows, resolved.supporting),
        score: round3(resolved.score),
        strength: round3(resolved.strength),
        priorOnly: resolved.priorOnly,
        classes: resolved.classesUsed,
        evidenceIds: rows.map((row) => row.id),
      };
    })
    .sort((a, b) => b.score - a.score);

  return { dimension, options, headline: headlineFor(dimension, options) };
}

function heaviestClaim(
  rows: Array<{ id: string; claim: string }>,
  weights: Array<{ id: string; weight: number }>,
): string {
  let best = rows[0]?.claim ?? "";
  let bestWeight = -1;
  for (const row of rows) {
    const weight = weights.find((item) => item.id === row.id)?.weight ?? 0;
    if (weight > bestWeight) {
      bestWeight = weight;
      best = row.claim;
    }
  }
  return best;
}

function headlineFor(dimension: string, options: DimensionOption[]): string {
  if (options.length === 0) {
    return `No evidence on ${dimension} yet — any choice here is an assumption to test.`;
  }
  const top = options[0]!;
  if (top.priorOnly) {
    return `Best available option for ${dimension} is "${top.groupKey}", from general priors only — nothing has been observed on this account.`;
  }
  return `Best-supported option for ${dimension} is "${top.groupKey}" (strength ${top.strength.toFixed(2)}).`;
}

async function publishBounds(projectId: string) {
  const [first, last] = await Promise.all([
    prisma.postPlatform.findFirst({
      where: { post: { projectId }, publishedAt: { not: null } },
      orderBy: { publishedAt: "asc" },
      select: { publishedAt: true },
    }),
    prisma.postPlatform.findFirst({
      where: { post: { projectId }, publishedAt: { not: null } },
      orderBy: { publishedAt: "desc" },
      select: { publishedAt: true },
    }),
  ]);
  return { first: first?.publishedAt ?? null, last: last?.publishedAt ?? null };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
