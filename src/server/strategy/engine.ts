import { prisma } from "@/server/db";
import {
  Confidence,
  EvidenceRelationship,
  StrategyStatus,
} from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { runAiOperation, strategyDraftPrompt } from "@/server/ai/orchestration";
import type { AiJobSummary, ModelProvider } from "@/server/ai/orchestration";
import { findEvidence, toWeighable } from "@/server/intelligence/evidence";
import { weighEvidence } from "@/server/intelligence/weighting";
import { buildStrategyContext, type StrategyContext } from "./context";

/**
 * The strategy engine.
 *
 * Produces an immutable `StrategyVersion` from the brand's evidence, and links
 * every strategic decision to the evidence behind it with a computed strength —
 * so "why this?" is answered with the same numbers the decision was made from,
 * not with a restatement of the decision.
 *
 * A version is never edited. A new strategy supersedes the old one and the old
 * one stays readable, because the interesting question later is what the system
 * believed *then*.
 */

export type GenerateStrategyResult =
  | { ok: true; strategyId: string; version: number; job: AiJobSummary }
  | { ok: false; reason: string; errorKind: string; job: AiJobSummary };

export async function generateStrategy(input: {
  workspaceId: string;
  projectId: string;
  /** Make it the ACTIVE strategy, superseding the previous one. */
  activate?: boolean;
  /** Test seam. */
  provider?: ModelProvider;
  now?: Date;
}): Promise<GenerateStrategyResult> {
  const context = await buildStrategyContext({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ...(input.now ? { now: input.now } : {}),
  });

  const result = await runAiOperation({
    prompt: strategyDraftPrompt,
    input: context,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ...(input.provider ? { provider: input.provider } : {}),
  });

  if (!result.ok) {
    // No half-written strategy. A failed draft leaves the AIJob record and
    // nothing else, so the previous ACTIVE strategy stays the current one.
    return {
      ok: false,
      reason: result.message,
      errorKind: result.errorKind,
      job: result.job,
    };
  }

  const draft = result.value;
  const audience = context.audiences.find((entry) => entry.name === draft.targetAudienceName);
  const primary = context.objectives.find((entry) => entry.kpi === draft.primaryObjectiveKpi);
  const secondary = context.objectives.find(
    (entry) => entry.kpi === draft.secondaryObjectiveKpi,
  );

  // Which evidence backs which decision. The link is per-decision rather than
  // per-strategy, so the panel can answer "why these hooks?" specifically.
  const links = collectEvidenceLinks(context, draft);
  const strengths = await computeStrengths({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    evidenceIds: [...new Set(links.map((link) => link.evidenceSourceId))],
    objective: draft.primaryObjectiveKpi,
    ...(input.now ? { now: input.now } : {}),
  });

  const strategyId = await prisma.$transaction(async (tx) => {
    const latest = await tx.strategyVersion.findFirst({
      where: { projectId: input.projectId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, status: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const created = await tx.strategyVersion.create({
      data: {
        projectId: input.projectId,
        version,
        status: input.activate ? StrategyStatus.ACTIVE : StrategyStatus.DRAFT,
        summary: draft.summary,
        targetAudienceId: audience?.id ?? null,
        primaryObjectiveId: primary?.id ?? null,
        secondaryObjectiveId: secondary?.id ?? null,
        contentPillars: draft.contentPillars,
        recommendedFormats: draft.recommendedFormats,
        hookFamilies: draft.hookFamilies,
        narrativeStructures: draft.narrativeStructures,
        ctaStrategy: draft.ctaStrategy,
        platformStrategy: draft.platformStrategy as Prisma.InputJsonValue,
        cadence: draft.cadence as Prisma.InputJsonValue,
        hypotheses: draft.hypotheses as unknown as Prisma.InputJsonValue,
        risks: draft.risks as unknown as Prisma.InputJsonValue,
        // The account's state as it was, so a later reader can see what this
        // strategy was working from rather than what is true today.
        accountState: context.accountState as unknown as Prisma.InputJsonValue,
        confidence: toConfidence(draft.confidence),
        generatedBy: result.job.provenance.providerName,
        model: result.job.provenance.model,
        promptVersion: `${result.job.provenance.promptName}@${result.job.provenance.promptVersion}`,
      },
    });

    if (links.length > 0) {
      await tx.strategyEvidence.createMany({
        data: links.map((link) => ({
          strategyVersionId: created.id,
          evidenceSourceId: link.evidenceSourceId,
          relationship: EvidenceRelationship.SUPPORTS,
          decision: link.decision,
          strength: strengths.get(link.evidenceSourceId) ?? 0,
        })),
        skipDuplicates: true,
      });
    }

    if (input.activate && latest && latest.status === StrategyStatus.ACTIVE) {
      await tx.strategyVersion.update({
        where: { id: latest.id },
        data: { status: StrategyStatus.SUPERSEDED, supersededById: created.id },
      });
    }

    return created.id;
  });

  return { ok: true, strategyId, version: await versionOf(strategyId), job: result.job };
}

/** Promotes a draft, superseding whatever was active. */
export async function activateStrategy(strategyId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const target = await tx.strategyVersion.findUniqueOrThrow({
      where: { id: strategyId },
      select: { id: true, projectId: true, status: true },
    });
    if (target.status === StrategyStatus.ACTIVE) return;

    const current = await tx.strategyVersion.findFirst({
      where: { projectId: target.projectId, status: StrategyStatus.ACTIVE },
      select: { id: true },
    });

    await tx.strategyVersion.update({
      where: { id: target.id },
      data: { status: StrategyStatus.ACTIVE },
    });

    if (current) {
      await tx.strategyVersion.update({
        where: { id: current.id },
        data: { status: StrategyStatus.SUPERSEDED, supersededById: target.id },
      });
    }
  });
}

export async function activeStrategy(projectId: string) {
  return prisma.strategyVersion.findFirst({
    where: { projectId, status: StrategyStatus.ACTIVE },
    orderBy: { version: "desc" },
    include: {
      targetAudience: true,
      evidence: { include: { evidence: true }, orderBy: { strength: "desc" } },
    },
  });
}

export async function strategyHistory(projectId: string) {
  return prisma.strategyVersion.findMany({
    where: { projectId },
    orderBy: { version: "desc" },
    include: { targetAudience: true, _count: { select: { evidence: true } } },
  });
}

/**
 * The "why this?" answer for one strategy, grouped by decision.
 *
 * Evidence classes stay separate here rather than being summed, because "three
 * priors and one experiment" and "four priors" are different situations and a
 * single total cannot tell them apart.
 */
export async function strategyRationale(strategyId: string) {
  const strategy = await prisma.strategyVersion.findUniqueOrThrow({
    where: { id: strategyId },
    include: { evidence: { include: { evidence: true }, orderBy: { strength: "desc" } } },
  });

  const byDecision = new Map<string, typeof strategy.evidence>();
  for (const link of strategy.evidence) {
    const key = link.decision ?? "general";
    byDecision.set(key, [...(byDecision.get(key) ?? []), link]);
  }

  return {
    strategy,
    decisions: [...byDecision.entries()].map(([decision, links]) => ({
      decision,
      links,
      classes: countClasses(links.map((link) => link.evidence.type)),
      priorOnly: links.every((link) => link.evidence.type === "GLOBAL_PRIOR"),
    })),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type EvidenceLink = { evidenceSourceId: string; decision: string };

/**
 * Maps the draft's choices back onto the evidence that was offered for them.
 *
 * Two sources: the ids the draft cited in its hypotheses, and the dimension
 * options it actually chose. The second matters because a strategy that picks
 * "problem_solution" hooks is resting on that option's evidence whether or not
 * it remembered to cite it.
 */
export function collectEvidenceLinks(
  context: StrategyContext,
  draft: {
    hookFamilies: string[];
    recommendedFormats: string[];
    hypotheses: Array<{ basedOn: string[]; dimension: string }>;
  },
): EvidenceLink[] {
  const links: EvidenceLink[] = [];
  const seen = new Set<string>();

  const add = (evidenceSourceId: string, decision: string) => {
    const key = `${evidenceSourceId}::${decision}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ evidenceSourceId, decision });
  };

  const optionsFor = (dimension: string) =>
    context.dimensions.find((digest) => digest.dimension === dimension)?.options ?? [];

  for (const family of draft.hookFamilies) {
    for (const option of optionsFor("hook")) {
      if (option.groupKey === family) {
        option.evidenceIds.forEach((id) => add(id, "hookFamilies"));
      }
    }
  }
  for (const format of draft.recommendedFormats) {
    for (const option of optionsFor("format")) {
      if (option.groupKey === format) {
        option.evidenceIds.forEach((id) => add(id, "recommendedFormats"));
      }
    }
  }

  const citable = new Set(context.citableEvidenceIds);
  draft.hypotheses.forEach((hypothesis, index) => {
    for (const id of hypothesis.basedOn) {
      // Validation already rejected invented ids; this is belt and braces so a
      // future caller cannot write a dangling foreign key.
      if (citable.has(id)) add(id, `hypotheses.${index}`);
    }
  });

  return links;
}

/**
 * Recomputes each linked item's weight so the stored strength is the same number
 * the decision was made from, rather than a label applied afterwards.
 */
async function computeStrengths(input: {
  workspaceId: string;
  projectId: string;
  evidenceIds: string[];
  objective: string | null;
  now?: Date;
}): Promise<Map<string, number>> {
  const strengths = new Map<string, number>();
  if (input.evidenceIds.length === 0) return strengths;

  const rows = await findEvidence({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    limit: 500,
  });

  const wanted = new Set(input.evidenceIds);
  for (const row of rows) {
    if (!wanted.has(row.id)) continue;
    const weighed = weighEvidence(toWeighable(row), {
      ...(input.now ? { now: input.now } : {}),
      objective: input.objective,
      dimension: row.dimension,
      groupKey: row.groupKey,
    });
    strengths.set(row.id, Math.round(weighed.weight * 1000) / 1000);
  }
  return strengths;
}

function countClasses(types: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of types) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

function toConfidence(value: "LOW" | "MEDIUM" | "HIGH"): Confidence {
  return value === "HIGH"
    ? Confidence.HIGH
    : value === "MEDIUM"
      ? Confidence.MEDIUM
      : Confidence.LOW;
}

async function versionOf(strategyId: string): Promise<number> {
  const row = await prisma.strategyVersion.findUniqueOrThrow({
    where: { id: strategyId },
    select: { version: true },
  });
  return row.version;
}
