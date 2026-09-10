import { prisma } from "@/server/db";
import {
  Confidence,
  EvidenceRelationship,
  EvidenceType,
  LearningStatus,
} from "@/generated/prisma/enums";
import { toWeighable } from "./evidence";
import { resolveClaim, type WeighingContext } from "./weighting";

/**
 * The lifecycle of an account-specific learning.
 *
 * A learning is a claim about *this brand*, and it has to earn that status. It
 * enters as a HYPOTHESIS and is promoted only by the weight of account or
 * experiment evidence behind it. Priors can suggest a hypothesis; they can never
 * promote one, because a prior is an assumption about content in general and
 * says nothing about this audience.
 *
 * Nothing is ever deleted. A claim that stops holding is WEAKENED, and a claim
 * replaced by a better one is SUPERSEDED with a pointer to its replacement, so
 * the record of what the system believed and when stays intact.
 */

/**
 * Promotion thresholds, expressed in resolved evidence strength (0..1) rather
 * than in raw post counts — five posts with a huge effect and five with a
 * marginal one are not the same finding, and a count cannot tell them apart.
 */
export const PROMOTION = {
  /** Below this, a claim stays a hypothesis. */
  emerging: 0.2,
  /** At or above this, a claim is strong enough to act on. */
  supported: 0.45,
  /** Net-negative evidence at or beyond this magnitude weakens a claim. */
  weakened: -0.15,
} as const;

/**
 * Only observation can promote a claim about this account. A prior proposes.
 */
const PROMOTING_TYPES: EvidenceType[] = [
  EvidenceType.ACCOUNT_EVIDENCE,
  EvidenceType.EXPERIMENT_EVIDENCE,
];

export type LearningScope = {
  dimension?: string | null;
  groupKey?: string | null;
  platform?: string | null;
  objective?: string | null;
};

export type UpsertLearningInput = {
  workspaceId: string;
  projectId?: string | null;
  claim: string;
  metric: string;
  scope?: LearningScope;
  /** Evidence ids that bear on the claim, with their relationship. */
  evidence: Array<{ evidenceSourceId: string; contradicts?: boolean }>;
};

/**
 * Creates or updates a learning and recomputes its standing from evidence.
 *
 * Idempotent per (project, dimension, groupKey, metric): re-running with more
 * evidence updates the existing claim rather than creating a rival copy of it.
 */
export async function upsertLearning(input: UpsertLearningInput) {
  const scope = input.scope ?? {};

  const existing = await prisma.learning.findFirst({
    where: {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      dimension: scope.dimension ?? null,
      groupKey: scope.groupKey ?? null,
      metric: input.metric,
      status: { not: LearningStatus.SUPERSEDED },
    },
  });

  const learning =
    existing ??
    (await prisma.learning.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        claim: input.claim,
        metric: input.metric,
        dimension: scope.dimension ?? null,
        groupKey: scope.groupKey ?? null,
        scope: scope as object,
        status: LearningStatus.HYPOTHESIS,
      },
    }));

  for (const link of input.evidence) {
    await prisma.learningEvidence.upsert({
      where: {
        learningId_evidenceSourceId: {
          learningId: learning.id,
          evidenceSourceId: link.evidenceSourceId,
        },
      },
      create: {
        learningId: learning.id,
        evidenceSourceId: link.evidenceSourceId,
        relationship: link.contradicts
          ? EvidenceRelationship.CONTRADICTS
          : EvidenceRelationship.SUPPORTS,
      },
      update: {
        relationship: link.contradicts
          ? EvidenceRelationship.CONTRADICTS
          : EvidenceRelationship.SUPPORTS,
      },
    });
  }

  return reassessLearning(learning.id, { claim: input.claim });
}

/**
 * Recomputes a learning's status, confidence and counts from its evidence.
 *
 * Separated from writing so that new evidence arriving later — an analytics
 * sync, a finished experiment — can re-open the question without anyone having
 * to remember to re-state the claim.
 */
export async function reassessLearning(
  learningId: string,
  options: { claim?: string; now?: Date } = {},
) {
  const learning = await prisma.learning.findUniqueOrThrow({
    where: { id: learningId },
    include: { evidence: { include: { evidence: true } } },
  });

  const context: WeighingContext = {
    now: options.now,
    dimension: learning.dimension,
    groupKey: learning.groupKey,
    objective:
      typeof (learning.scope as Record<string, unknown>)?.objective === "string"
        ? ((learning.scope as Record<string, unknown>).objective as string)
        : null,
  };

  const resolved = resolveClaim(
    learning.evidence.map((link) => ({
      evidence: toWeighable(link.evidence),
      contradicts: link.relationship === EvidenceRelationship.CONTRADICTS,
    })),
    context,
  );

  // Only observed evidence counts toward promotion; priors cannot promote.
  const promoting = learning.evidence.filter(
    (link) =>
      link.relationship === EvidenceRelationship.SUPPORTS &&
      PROMOTING_TYPES.includes(link.evidence.type),
  );
  const promotable = resolveClaim(
    promoting.map((link) => ({ evidence: toWeighable(link.evidence) })),
    context,
  );

  const contradicting = learning.evidence.filter(
    (link) => link.relationship === EvidenceRelationship.CONTRADICTS,
  );

  const status = decideStatus({
    promotableScore: promotable.score,
    netScore: resolved.score,
    hasObservedEvidence: promoting.length > 0,
  });

  // Persist each link's computed contribution so the UI can show its working.
  for (const link of learning.evidence) {
    const weighed = [...resolved.supporting, ...resolved.contradicting].find(
      (item) => item.id === link.evidenceSourceId,
    );
    if (!weighed) continue;
    await prisma.learningEvidence.update({
      where: {
        learningId_evidenceSourceId: {
          learningId: learning.id,
          evidenceSourceId: link.evidenceSourceId,
        },
      },
      data: { strength: weighed.weight },
    });
  }

  const sampleSize = learning.evidence
    .filter((link) => PROMOTING_TYPES.includes(link.evidence.type))
    .reduce((sum, link) => sum + link.evidence.sampleSize, 0);

  const effectSizes = promoting
    .map((link) => link.evidence.effectSize)
    .filter((value): value is number => value !== null);

  return prisma.learning.update({
    where: { id: learning.id },
    data: {
      ...(options.claim ? { claim: options.claim } : {}),
      status,
      confidence: confidenceFor(resolved.strength, promoting.length > 0),
      supportingCount: resolved.supporting.filter((item) => item.weight > 0).length,
      contradictingCount: contradicting.length,
      sampleSize,
      effectSize:
        effectSizes.length > 0
          ? effectSizes.reduce((sum, value) => sum + value, 0) / effectSizes.length
          : null,
    },
  });
}

/**
 * Status is decided by observed evidence, then checked against contradiction.
 *
 * A claim with no observation of this account cannot rise above HYPOTHESIS
 * however plausible the prior behind it is.
 */
export function decideStatus(input: {
  promotableScore: number;
  netScore: number;
  hasObservedEvidence: boolean;
}): LearningStatus {
  if (input.netScore <= PROMOTION.weakened) return LearningStatus.WEAKENED;
  if (!input.hasObservedEvidence) return LearningStatus.HYPOTHESIS;
  if (input.promotableScore >= PROMOTION.supported) return LearningStatus.SUPPORTED;
  if (input.promotableScore >= PROMOTION.emerging) return LearningStatus.EMERGING;
  return LearningStatus.HYPOTHESIS;
}

export function confidenceFor(
  strength: number,
  hasObservedEvidence: boolean,
): Confidence {
  // Without observation of this account, confidence is capped low no matter how
  // internally consistent the priors are.
  if (!hasObservedEvidence) return Confidence.LOW;
  if (strength >= PROMOTION.supported) return Confidence.HIGH;
  if (strength >= PROMOTION.emerging) return Confidence.MEDIUM;
  return Confidence.LOW;
}

/** Retires a learning in favour of a newer one, keeping the chain intact. */
export async function supersedeLearning(
  oldId: string,
  newId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.learning.update({
      where: { id: oldId },
      data: { status: LearningStatus.SUPERSEDED, supersededById: newId },
    }),
  ]);
}

/**
 * Learnings usable for planning: brand-specific, still standing, ordered by how
 * well supported they are.
 */
export async function activeLearnings(input: {
  workspaceId: string;
  projectId?: string | null;
  dimension?: string | null;
  minStatus?: LearningStatus;
}) {
  const allowed =
    input.minStatus === LearningStatus.SUPPORTED
      ? [LearningStatus.SUPPORTED]
      : [
          LearningStatus.SUPPORTED,
          LearningStatus.EMERGING,
          LearningStatus.HYPOTHESIS,
        ];

  return prisma.learning.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.dimension ? { dimension: input.dimension } : {}),
      status: { in: allowed },
    },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
    include: { evidence: { include: { evidence: true } } },
  });
}

/**
 * Whether this brand has enough of its own evidence to plan from, or is still
 * cold-starting. Drives whether the strategy engine leans on priors.
 */
export async function coldStartState(input: {
  workspaceId: string;
  projectId: string;
}): Promise<{
  cold: boolean;
  accountObservations: number;
  experiments: number;
  reason: string;
}> {
  const [accountObservations, experiments] = await Promise.all([
    prisma.evidenceSource.count({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        type: EvidenceType.ACCOUNT_EVIDENCE,
      },
    }),
    prisma.evidenceSource.count({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        type: EvidenceType.EXPERIMENT_EVIDENCE,
      },
    }),
  ]);

  const cold = accountObservations + experiments === 0;
  return {
    cold,
    accountObservations,
    experiments,
    reason: cold
      ? "No observations from this account yet, so planning leans on general priors and deliberate tests."
      : `${accountObservations} account observation${accountObservations === 1 ? "" : "s"} and ${experiments} experiment result${experiments === 1 ? "" : "s"} available.`,
  };
}
