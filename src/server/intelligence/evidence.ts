import { prisma } from "@/server/db";
import { EvidenceType } from "@/generated/prisma/enums";
import type { Platform, Prisma } from "@/generated/prisma/client";
import type { WeighableEvidence } from "./weighting";

/**
 * Recording and reading evidence.
 *
 * Everything strategic in this system must be traceable to observations, and
 * those observations must keep their provenance. This module is the only way
 * evidence enters the database, so there is one place where "what kind of thing
 * is this, and what does it actually show" is decided.
 *
 * The four classes are never merged. A prior can inform a recommendation but can
 * never be counted as something this account demonstrated.
 */

export type RecordEvidenceInput = {
  workspaceId: string;
  /** Null for workspace-wide evidence such as a shipped prior. */
  projectId?: string | null;
  type: EvidenceType;
  sourceEntityType: string;
  sourceEntityId?: string | null;
  provider?: string | null;
  claim: string;
  dimension?: string | null;
  groupKey?: string | null;
  metric: string;
  value?: number | null;
  baseline?: number | null;
  effectSize?: number | null;
  sampleSize?: number;
  /** 0..1 as asserted by the producer. */
  confidence?: number;
  observedAt?: Date;
  expiresAt?: Date | null;
  platform?: Platform | null;
  objective?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export async function recordEvidence(input: RecordEvidenceInput) {
  return prisma.evidenceSource.create({
    data: {
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      type: input.type,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId ?? null,
      provider: input.provider ?? null,
      claim: input.claim,
      dimension: input.dimension ?? null,
      groupKey: input.groupKey ?? null,
      metric: input.metric,
      value: input.value ?? null,
      baseline: input.baseline ?? null,
      effectSize: input.effectSize ?? null,
      sampleSize: input.sampleSize ?? 0,
      confidence: clamp01(input.confidence ?? 0),
      observedAt: input.observedAt ?? new Date(),
      expiresAt: input.expiresAt ?? null,
      platform: input.platform ?? null,
      objective: input.objective ?? null,
      metadata: input.metadata ?? {},
    },
  });
}

/**
 * Replaces a provider's previous evidence of one kind for a project.
 *
 * Priors and external observations are *restatements* of a current view, not an
 * accumulating history — re-running a provider should not pile up twenty copies
 * of the same claim and thereby fake a large sample. Account and experiment
 * evidence is append-only and must never go through here.
 */
export async function replaceProviderEvidence(input: {
  workspaceId: string;
  projectId?: string | null;
  // Literal union rather than EvidenceType.X: the generated enum is a const
  // object, so it has no type-level namespace to index into.
  type: "GLOBAL_PRIOR" | "EXTERNAL_EVIDENCE";
  provider: string;
  items: Omit<RecordEvidenceInput, "workspaceId" | "projectId" | "type" | "provider">[];
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.evidenceSource.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        type: input.type,
        provider: input.provider,
      },
    });

    if (input.items.length === 0) return 0;

    await tx.evidenceSource.createMany({
      data: input.items.map((item) => ({
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        type: input.type,
        provider: input.provider,
        sourceEntityType: item.sourceEntityType,
        sourceEntityId: item.sourceEntityId ?? null,
        claim: item.claim,
        dimension: item.dimension ?? null,
        groupKey: item.groupKey ?? null,
        metric: item.metric,
        value: item.value ?? null,
        baseline: item.baseline ?? null,
        effectSize: item.effectSize ?? null,
        sampleSize: item.sampleSize ?? 0,
        confidence: clamp01(item.confidence ?? 0),
        observedAt: item.observedAt ?? new Date(),
        expiresAt: item.expiresAt ?? null,
        platform: item.platform ?? null,
        objective: item.objective ?? null,
        metadata: (item.metadata ?? {}) as Prisma.InputJsonValue,
      })),
    });

    return input.items.length;
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type EvidenceQuery = {
  workspaceId: string;
  projectId?: string | null;
  types?: EvidenceType[];
  dimension?: string | null;
  groupKey?: string | null;
  objective?: string | null;
  /** Excludes expired external evidence. Defaults to true. */
  excludeExpired?: boolean;
  limit?: number;
};

/**
 * Fetches candidate evidence for a question.
 *
 * Project-scoped evidence AND workspace-wide priors are both returned: the
 * caller is meant to weigh them against each other, not to choose a lane.
 */
export async function findEvidence(query: EvidenceQuery) {
  const now = new Date();
  return prisma.evidenceSource.findMany({
    where: {
      workspaceId: query.workspaceId,
      ...(query.projectId !== undefined
        ? { OR: [{ projectId: query.projectId }, { projectId: null }] }
        : {}),
      ...(query.types ? { type: { in: query.types } } : {}),
      ...(query.dimension ? { dimension: query.dimension } : {}),
      ...(query.groupKey ? { groupKey: query.groupKey } : {}),
      ...(query.objective ? { objective: query.objective } : {}),
      ...(query.excludeExpired === false
        ? {}
        : { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }),
    },
    orderBy: { observedAt: "desc" },
    take: query.limit ?? 200,
  });
}

/** Narrows a stored row to what the weighting mechanism actually needs. */
export function toWeighable(row: {
  id: string;
  type: EvidenceType;
  confidence: number;
  sampleSize: number;
  effectSize: number | null;
  observedAt: Date;
  expiresAt: Date | null;
  dimension: string | null;
  groupKey: string | null;
  objective: string | null;
}): WeighableEvidence {
  return {
    id: row.id,
    type: row.type,
    confidence: row.confidence,
    sampleSize: row.sampleSize,
    effectSize: row.effectSize,
    observedAt: row.observedAt,
    expiresAt: row.expiresAt,
    dimension: row.dimension,
    groupKey: row.groupKey,
    objective: row.objective,
  };
}

// ---------------------------------------------------------------------------
// Provenance summary, for the "why this?" panel
// ---------------------------------------------------------------------------

export type ProvenanceSummary = {
  accountEvidence: number;
  experimentEvidence: number;
  externalEvidence: number;
  globalPriors: number;
  /** True when only priors are behind the claim — a cold-start assumption. */
  priorOnly: boolean;
  /** One line an operator can read without expanding anything. */
  headline: string;
};

export function summariseProvenance(
  types: EvidenceType[],
): ProvenanceSummary {
  const count = (type: EvidenceType) =>
    types.filter((entry) => entry === type).length;

  const accountEvidence = count(EvidenceType.ACCOUNT_EVIDENCE);
  const experimentEvidence = count(EvidenceType.EXPERIMENT_EVIDENCE);
  const externalEvidence = count(EvidenceType.EXTERNAL_EVIDENCE);
  const globalPriors = count(EvidenceType.GLOBAL_PRIOR);

  const observed = accountEvidence + experimentEvidence + externalEvidence;
  const priorOnly = observed === 0 && globalPriors > 0;

  let headline: string;
  if (types.length === 0) {
    headline = "No evidence recorded.";
  } else if (priorOnly) {
    headline =
      "Based on general priors only — nothing has been observed on this account yet.";
  } else if (experimentEvidence > 0) {
    headline = `Backed by ${experimentEvidence} controlled test${experimentEvidence === 1 ? "" : "s"} on this account.`;
  } else if (accountEvidence > 0) {
    headline = `Based on ${accountEvidence} observation${accountEvidence === 1 ? "" : "s"} from this account's own results.`;
  } else {
    headline = `Based on ${externalEvidence} outside observation${externalEvidence === 1 ? "" : "s"}.`;
  }

  return {
    accountEvidence,
    experimentEvidence,
    externalEvidence,
    globalPriors,
    priorOnly,
    headline,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
