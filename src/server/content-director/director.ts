import { prisma } from "@/server/db";
import {
  BriefStatus,
  ContentPlanStatus,
  Platform,
  type ContentFormat,
} from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { contentPlanPrompt, runAiOperation } from "@/server/ai/orchestration";
import type { AiJobSummary, ModelProvider } from "@/server/ai/orchestration";
import { buildPlanContext, planSlots, type PlanContext } from "./context";

/**
 * The content director.
 *
 * Turns the active strategy into a window of concrete briefs, each carrying the
 * strategy decision it serves. That link is the point: a published post traces
 * back to a brief, the brief to a strategy decision, the decision to the
 * evidence that argued for it. Break any link and "why did we post this?" stops
 * having an answer.
 *
 * Like a strategy, a plan is immutable. Replanning creates a new version and
 * supersedes the old, and briefs already fulfilled are carried forward rather
 * than orphaned — a post that exists is a fact, whatever the plan now says.
 */

export type CreatePlanResult =
  | { ok: true; planId: string; version: number; briefs: number; job: AiJobSummary }
  | { ok: false; reason: string; errorKind: string; job: AiJobSummary };

export async function createContentPlan(input: {
  workspaceId: string;
  projectId: string;
  startsOn?: Date;
  days?: number;
  briefTarget?: number;
  activate?: boolean;
  provider?: ModelProvider;
}): Promise<CreatePlanResult> {
  const context = await buildPlanContext({
    projectId: input.projectId,
    ...(input.startsOn ? { startsOn: input.startsOn } : {}),
    ...(input.days !== undefined ? { days: input.days } : {}),
    ...(input.briefTarget !== undefined ? { briefTarget: input.briefTarget } : {}),
  });

  const result = await runAiOperation({
    prompt: contentPlanPrompt,
    input: context,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ...(input.provider ? { provider: input.provider } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.message,
      errorKind: result.errorKind,
      job: result.job,
    };
  }

  const plan = result.value;
  const startsOn = new Date(`${context.window.startsOn}T00:00:00`);
  const endsOn = new Date(`${context.window.endsOn}T23:59:59`);
  const times = await planSlots({
    projectId: input.projectId,
    startsOn,
    days: context.window.days,
    count: plan.briefs.length,
  });

  const audienceId = context.strategy.targetAudienceId;
  const platforms = context.platforms.filter((platform): platform is Platform =>
    Object.values(Platform).includes(platform as Platform),
  );

  const created = await prisma.$transaction(async (tx) => {
    const latest = await tx.contentPlan.findFirst({
      where: { projectId: input.projectId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, status: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const row = await tx.contentPlan.create({
      data: {
        projectId: input.projectId,
        strategyVersionId: context.strategy.id,
        version,
        status: input.activate ? ContentPlanStatus.ACTIVE : ContentPlanStatus.DRAFT,
        startsOn,
        endsOn,
        timezone: context.window.timezone,
        summary: plan.summary,
        targetMix: targetMix(plan.briefs) as Prisma.InputJsonValue,
        rationale: {
          cadenceSource: context.window.cadenceSource,
          slotCount: context.window.slotCount,
          briefTarget: context.window.briefTarget,
          strategyVersion: context.strategy.version,
          strategyConfidence: context.strategy.confidence,
          gaps: plan.gaps,
        } as Prisma.InputJsonValue,
        generatedBy: result.job.provenance.providerName,
        model: result.job.provenance.model,
        promptVersion: `${result.job.provenance.promptName}@${result.job.provenance.promptVersion}`,
      },
    });

    await tx.contentBrief.createMany({
      data: plan.briefs.map((brief, index) => ({
        planId: row.id,
        projectId: input.projectId,
        sequence: index + 1,
        status: BriefStatus.PLANNED,
        workingTitle: brief.workingTitle,
        angle: brief.angle,
        keyMessage: brief.keyMessage,
        pillarSlug: brief.pillarSlug,
        format: brief.format as ContentFormat,
        hookFamily: brief.hookFamily,
        minSeconds: brief.minSeconds,
        maxSeconds: brief.maxSeconds,
        targetAudienceId: audienceId,
        objectiveKpi: brief.objectiveKpi,
        plannedFor: times[index] ?? null,
        platforms,
        productionNotes: brief.productionNotes,
        strategyBasis: brief.strategyBasis,
        isExperiment: brief.isExperiment,
        hypothesisIndex: brief.hypothesisIndex,
      })),
    });

    if (input.activate && latest && latest.status === ContentPlanStatus.ACTIVE) {
      await tx.contentPlan.update({
        where: { id: latest.id },
        data: { status: ContentPlanStatus.SUPERSEDED, supersededById: row.id },
      });
    }

    return { id: row.id, version };
  });

  return {
    ok: true,
    planId: created.id,
    version: created.version,
    briefs: plan.briefs.length,
    job: result.job,
  };
}

export async function activateContentPlan(planId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const target = await tx.contentPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { id: true, projectId: true, status: true },
    });
    if (target.status === ContentPlanStatus.ACTIVE) return;

    const current = await tx.contentPlan.findFirst({
      where: { projectId: target.projectId, status: ContentPlanStatus.ACTIVE },
      select: { id: true },
    });

    await tx.contentPlan.update({
      where: { id: target.id },
      data: { status: ContentPlanStatus.ACTIVE },
    });
    if (current) {
      await tx.contentPlan.update({
        where: { id: current.id },
        data: { status: ContentPlanStatus.SUPERSEDED, supersededById: target.id },
      });
    }
  });
}

export async function activePlan(projectId: string) {
  return prisma.contentPlan.findFirst({
    where: { projectId, status: ContentPlanStatus.ACTIVE },
    orderBy: { version: "desc" },
    include: {
      strategy: { select: { version: true, confidence: true, summary: true } },
      briefs: {
        orderBy: { sequence: "asc" },
        include: { targetAudience: { select: { name: true } }, post: { select: { id: true, status: true } } },
      },
    },
  });
}

export async function planHistory(projectId: string) {
  return prisma.contentPlan.findMany({
    where: { projectId },
    orderBy: { version: "desc" },
    include: {
      strategy: { select: { version: true } },
      _count: { select: { briefs: true } },
    },
  });
}

/**
 * Attaches a post to the brief that asked for it.
 *
 * This is the join that makes a published post traceable. It is deliberately
 * explicit rather than inferred from timing or pillar, because a guess here
 * would produce a confident but wrong answer to "why did we post this?".
 */
export async function fulfilBrief(input: {
  briefId: string;
  postId: string;
}): Promise<void> {
  await prisma.contentBrief.update({
    where: { id: input.briefId },
    data: { postId: input.postId, status: BriefStatus.FULFILLED },
  });
}

export async function skipBrief(input: {
  briefId: string;
  reason: string;
}): Promise<void> {
  await prisma.contentBrief.update({
    where: { id: input.briefId },
    data: { status: BriefStatus.SKIPPED, skipReason: input.reason },
  });
}

export async function setBriefStatus(
  briefId: string,
  status: BriefStatus,
): Promise<void> {
  await prisma.contentBrief.update({ where: { id: briefId }, data: { status } });
}

/**
 * Planned mix against delivered mix.
 *
 * A plan that says "half screen recordings" and a feed that is nine tenths
 * talking heads is a real finding, and it is invisible unless both numbers are
 * kept. Delivered counts only fulfilled briefs — intent is not delivery.
 */
export async function planAdherence(planId: string): Promise<{
  planned: MixCounts;
  delivered: MixCounts;
  fulfilled: number;
  skipped: number;
  outstanding: number;
  overdue: number;
}> {
  const briefs = await prisma.contentBrief.findMany({
    where: { planId },
    select: {
      status: true,
      format: true,
      pillarSlug: true,
      hookFamily: true,
      plannedFor: true,
      isExperiment: true,
    },
  });

  const now = new Date();
  const delivered = briefs.filter((brief) => brief.status === BriefStatus.FULFILLED);
  const skipped = briefs.filter((brief) => brief.status === BriefStatus.SKIPPED);
  const outstanding = briefs.filter(
    (brief) => brief.status !== BriefStatus.FULFILLED && brief.status !== BriefStatus.SKIPPED,
  );

  return {
    planned: mixOf(briefs),
    delivered: mixOf(delivered),
    fulfilled: delivered.length,
    skipped: skipped.length,
    outstanding: outstanding.length,
    overdue: outstanding.filter((brief) => brief.plannedFor !== null && brief.plannedFor < now)
      .length,
  };
}

export type MixCounts = {
  formats: Record<string, number>;
  pillars: Record<string, number>;
  hookFamilies: Record<string, number>;
  experiments: number;
  total: number;
};

function mixOf(
  briefs: Array<{
    format: string;
    pillarSlug: string | null;
    hookFamily: string | null;
    isExperiment: boolean;
  }>,
): MixCounts {
  const counts: MixCounts = {
    formats: {},
    pillars: {},
    hookFamilies: {},
    experiments: 0,
    total: briefs.length,
  };
  for (const brief of briefs) {
    counts.formats[brief.format] = (counts.formats[brief.format] ?? 0) + 1;
    const pillar = brief.pillarSlug ?? "unassigned";
    counts.pillars[pillar] = (counts.pillars[pillar] ?? 0) + 1;
    const hook = brief.hookFamily ?? "unassigned";
    counts.hookFamilies[hook] = (counts.hookFamilies[hook] ?? 0) + 1;
    if (brief.isExperiment) counts.experiments += 1;
  }
  return counts;
}

function targetMix(
  briefs: Array<{
    format: string;
    pillarSlug: string | null;
    hookFamily: string | null;
    isExperiment: boolean;
  }>,
): MixCounts {
  return mixOf(briefs);
}

export type { PlanContext };
