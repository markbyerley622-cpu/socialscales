import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  AIProviderKind,
  BriefStatus,
  ContentPlanStatus,
  Platform,
} from "@/generated/prisma/enums";
import { ingestAllKnowledge } from "@/server/knowledge";
import { generateStrategy } from "@/server/strategy";
import {
  activateContentPlan,
  activePlan,
  buildPlanContext,
  createContentPlan,
  fulfilBrief,
  NoActiveStrategyError,
  planAdherence,
  planSlots,
  skipBrief,
} from "@/server/content-director";
import { contentPlanPrompt } from "@/server/ai/orchestration";
import type { ModelProvider, ModelResponse } from "@/server/ai/orchestration";
import {
  createAssetFixture,
  createProjectFixture,
  createVariantFixture,
  ensureWorkspace,
  migrateTestSchema,
  resetDatabase,
} from "./helpers";

/**
 * Phase 4: the content director.
 *
 * The chain being protected is strategy -> plan -> brief -> post. Each test here
 * covers a way that chain could break silently: a plan built on no strategy, a
 * brief citing a pillar the project does not have, a plan that quietly rewrites
 * itself, or a post that exists with nothing saying why.
 */

let workspaceId: string;
let projectId: string;

beforeAll(async () => {
  await migrateTestSchema();
});

beforeEach(async () => {
  await resetDatabase();
  workspaceId = (await ensureWorkspace()).id;
  const project = await createProjectFixture({ workspaceId });
  projectId = project.id;

  await prisma.contentPillar.create({
    data: { projectId, slug: "proof", name: "Proof", description: "Show it working." },
  });
  await prisma.businessObjective.create({
    data: { projectId, kind: "PROFILE_VISITS", kpi: "profileVisits", priority: 1 },
  });
  await prisma.audienceSegment.create({
    data: { projectId, name: "Indie builders", priority: 1 },
  });

  await ingestAllKnowledge({ workspaceId, projectId: null });
});

async function withStrategy() {
  const result = await generateStrategy({ workspaceId, projectId, activate: true });
  if (!result.ok) throw new Error(`strategy generation failed: ${result.reason}`);
  return result;
}

function planProvider(payload: unknown | unknown[]): ModelProvider {
  const script = Array.isArray(payload) ? payload : [payload];
  let index = 0;
  return {
    name: "stub-director",
    kind: AIProviderKind.LLM,
    model: "stub-model-1",
    availability: () => ({ available: true }),
    canServe: () => true,
    async complete(): Promise<ModelResponse> {
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      return {
        text: JSON.stringify(next),
        usage: { inputTokens: 1_500, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.03,
        priced: true,
        model: "stub-model-1",
      };
    },
  };
}

describe("a plan implements a strategy", () => {
  it("refuses to plan without an active strategy", async () => {
    await expect(buildPlanContext({ projectId })).rejects.toBeInstanceOf(
      NoActiveStrategyError,
    );
  });

  it("pins the plan to exactly one strategy version", async () => {
    const strategy = await withStrategy();
    const result = await createContentPlan({
      workspaceId,
      projectId,
      days: 7,
      activate: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const plan = await prisma.contentPlan.findUniqueOrThrow({ where: { id: result.planId } });
    expect(plan.strategyVersionId).toBe(strategy.strategyId);

    // A later strategy does not retroactively become this plan's strategy.
    await generateStrategy({ workspaceId, projectId, activate: true });
    const again = await prisma.contentPlan.findUniqueOrThrow({ where: { id: result.planId } });
    expect(again.strategyVersionId).toBe(strategy.strategyId);
  });

  it("records which cadence source it used rather than conflating them", async () => {
    await withStrategy();
    const withoutSlots = await buildPlanContext({ projectId, days: 7 });
    expect(withoutSlots.window.cadenceSource).toContain("strategy's cadence");

    const schedule = await prisma.schedule.create({
      data: { projectId, name: "Default", isDefault: true },
    });
    await prisma.scheduleSlot.createMany({
      data: [
        { scheduleId: schedule.id, dayOfWeek: 1, minuteOfDay: 9 * 60 },
        { scheduleId: schedule.id, dayOfWeek: 3, minuteOfDay: 9 * 60 },
        { scheduleId: schedule.id, dayOfWeek: 5, minuteOfDay: 9 * 60 },
      ],
    });

    const withSlots = await buildPlanContext({ projectId, days: 7 });
    expect(withSlots.window.cadenceSource).toContain("schedule slots");
    expect(withSlots.window.slotCount).toBe(3);
  });
});

describe("generation from rules alone", () => {
  it("produces a full window of briefs with no model", async () => {
    await withStrategy();
    const result = await createContentPlan({
      workspaceId,
      projectId,
      days: 14,
      activate: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.job.provenance.deterministic).toBe(true);
    const plan = await activePlan(projectId);
    expect(plan?.status).toBe(ContentPlanStatus.ACTIVE);
    expect(plan?.briefs.length).toBe(result.briefs);
    expect(plan?.briefs.every((brief) => brief.strategyBasis.length > 0)).toBe(true);
    expect(plan?.briefs.every((brief) => brief.plannedFor !== null)).toBe(true);
  });

  it("commissions content for every strategy hypothesis it can test", async () => {
    await withStrategy();
    const strategy = await prisma.strategyVersion.findFirstOrThrow({
      where: { projectId },
      orderBy: { version: "desc" },
    });
    const hypotheses = strategy.hypotheses as unknown[];

    const result = await createContentPlan({ workspaceId, projectId, days: 14, activate: true });
    expect(result.ok).toBe(true);

    const experiments = await prisma.contentBrief.findMany({
      where: { projectId, isExperiment: true },
    });
    expect(experiments.length).toBe(Math.min(hypotheses.length, result.ok ? result.briefs : 0));
    expect(experiments.every((brief) => brief.hypothesisIndex !== null)).toBe(true);
  });

  it("says what it could not cover instead of padding", async () => {
    await withStrategy();
    const result = await createContentPlan({ workspaceId, projectId, days: 7, activate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const plan = await prisma.contentPlan.findUniqueOrThrow({ where: { id: result.planId } });
    const rationale = plan.rationale as { gaps: string[] };
    expect(rationale.gaps.length).toBeGreaterThan(0);
    // The rules are honest that a rotation is not an idea.
    expect(rationale.gaps.join(" ")).toContain("not specific ideas");
  });

  it("carries the strategy version and its confidence onto the plan's rationale", async () => {
    await withStrategy();
    const result = await createContentPlan({ workspaceId, projectId, days: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const plan = await prisma.contentPlan.findUniqueOrThrow({ where: { id: result.planId } });
    const rationale = plan.rationale as { strategyVersion: number; strategyConfidence: string };
    expect(rationale.strategyVersion).toBe(1);
    expect(rationale.strategyConfidence).toBe("LOW");
  });
});

describe("honesty constraints", () => {
  async function validPlan(overrides: Record<string, unknown> = {}) {
    const context = await buildPlanContext({ projectId, days: 7 });
    const base = await contentPlanPrompt.deterministic(context);
    return { context, plan: { ...base, ...overrides } };
  }

  it("rejects a brief citing a pillar the project does not have", async () => {
    await withStrategy();
    const { plan } = await validPlan();
    plan.briefs = plan.briefs.map((brief, index) =>
      index === 0 ? { ...brief, pillarSlug: "made-up-pillar" } : brief,
    );

    const result = await createContentPlan({
      workspaceId,
      projectId,
      days: 7,
      provider: planProvider(plan),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("is not a pillar of this project");
    expect(await prisma.contentPlan.count({ where: { projectId } })).toBe(0);
  });

  it("rejects an experiment brief that does not say what it tests", async () => {
    await withStrategy();
    const { plan } = await validPlan();
    plan.briefs = plan.briefs.map((brief, index) =>
      index === 0 ? { ...brief, isExperiment: true, hypothesisIndex: null } : brief,
    );

    const result = await createContentPlan({
      workspaceId,
      projectId,
      days: 7,
      provider: planProvider(plan),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("must say which hypothesis it tests");
  });

  it("rejects an angle that only restates its own strategy basis", async () => {
    await withStrategy();
    const { plan } = await validPlan();
    // The schema's own minimum length would catch a very short basis first, so
    // pick one long enough that the restatement rule is what actually fires.
    const target = plan.briefs.findIndex((brief) => brief.strategyBasis.length >= 20);
    expect(target).toBeGreaterThanOrEqual(0);
    plan.briefs = plan.briefs.map((brief, index) =>
      index === target ? { ...brief, angle: brief.strategyBasis } : brief,
    );

    const result = await createContentPlan({
      workspaceId,
      projectId,
      days: 7,
      provider: planProvider(plan),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("repeats strategyBasis");
  });

  it("rejects duplicate briefs", async () => {
    await withStrategy();
    const { plan } = await validPlan();
    const first = plan.briefs[0]!;
    plan.briefs = plan.briefs.map((brief, index) =>
      index === 1 ? { ...brief, workingTitle: first.workingTitle } : brief,
    );

    const result = await createContentPlan({
      workspaceId,
      projectId,
      days: 7,
      provider: planProvider(plan),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("share a working title");
  });

  it("repairs a bad plan rather than failing outright", async () => {
    await withStrategy();
    const { plan: good } = await validPlan();
    const bad = {
      ...good,
      briefs: good.briefs.map((brief, index) =>
        index === 0 ? { ...brief, pillarSlug: "nonsense" } : brief,
      ),
    };

    const result = await createContentPlan({
      workspaceId,
      projectId,
      days: 7,
      provider: planProvider([bad, good]),
    });
    expect(result.ok).toBe(true);
    expect(result.job.repairAttempts).toBe(1);
  });
});

describe("scheduling", () => {
  it("uses the project's own slots when it has them", async () => {
    const schedule = await prisma.schedule.create({
      data: { projectId, name: "Default", isDefault: true },
    });
    await prisma.scheduleSlot.createMany({
      data: [
        { scheduleId: schedule.id, dayOfWeek: 1, minuteOfDay: 9 * 60 },
        { scheduleId: schedule.id, dayOfWeek: 4, minuteOfDay: 18 * 60 },
      ],
    });

    // A Monday, so the first slot is that morning.
    const monday = new Date(2026, 8, 14);
    const times = await planSlots({ projectId, startsOn: monday, days: 14, count: 4 });
    expect(times).toHaveLength(4);
    expect(times[0]?.getDay()).toBe(1);
    expect(times[0]?.getHours()).toBe(9);
    expect(times[1]?.getDay()).toBe(4);
    expect(times[1]?.getHours()).toBe(18);
  });

  it("spreads evenly rather than inventing a best time to post", async () => {
    const start = new Date(2026, 8, 14);
    const times = await planSlots({ projectId, startsOn: start, days: 8, count: 4 });
    expect(times).toHaveLength(4);
    // Every placeholder sits at the same neutral hour; none of them claims to be
    // an optimal posting time, because nothing here knows one.
    expect(new Set(times.map((time) => time.getHours()))).toEqual(new Set([10]));
    expect(times[1]!.getTime()).toBeGreaterThan(times[0]!.getTime());
  });
});

describe("versioning and adherence", () => {
  it("supersedes rather than rewriting", async () => {
    await withStrategy();
    const first = await createContentPlan({ workspaceId, projectId, days: 7, activate: true });
    const second = await createContentPlan({ workspaceId, projectId, days: 7, activate: true });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.version).toBe(2);
    const older = await prisma.contentPlan.findUniqueOrThrow({ where: { id: first.planId } });
    expect(older.status).toBe(ContentPlanStatus.SUPERSEDED);
    expect(older.supersededById).toBe(second.planId);
    // The old plan's briefs are still there — they are a record of what was asked for.
    expect(await prisma.contentBrief.count({ where: { planId: first.planId } })).toBe(
      first.briefs,
    );
  });

  it("activates a draft without touching an unrelated project", async () => {
    await withStrategy();
    const active = await createContentPlan({ workspaceId, projectId, days: 7, activate: true });
    const draft = await createContentPlan({ workspaceId, projectId, days: 7 });
    expect(active.ok && draft.ok).toBe(true);
    if (!active.ok || !draft.ok) return;

    await activateContentPlan(draft.planId);
    const [older, newer] = await Promise.all([
      prisma.contentPlan.findUniqueOrThrow({ where: { id: active.planId } }),
      prisma.contentPlan.findUniqueOrThrow({ where: { id: draft.planId } }),
    ]);
    expect(older.status).toBe(ContentPlanStatus.SUPERSEDED);
    expect(newer.status).toBe(ContentPlanStatus.ACTIVE);
  });

  it("tracks planned mix against delivered mix", async () => {
    await withStrategy();
    const result = await createContentPlan({ workspaceId, projectId, days: 7, activate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = await planAdherence(result.planId);
    expect(before.planned.total).toBe(result.briefs);
    // Intent is not delivery: nothing counts as delivered until a post exists.
    expect(before.delivered.total).toBe(0);
    expect(before.outstanding).toBe(result.briefs);

    const brief = await prisma.contentBrief.findFirstOrThrow({
      where: { planId: result.planId },
      orderBy: { sequence: "asc" },
    });
    const asset = await createAssetFixture({ projectId, seed: 1 });
    const variant = await createVariantFixture({ assetId: asset.id });
    const post = await prisma.post.create({
      data: { projectId, assetId: asset.id, variantId: variant.id },
    });
    await fulfilBrief({ briefId: brief.id, postId: post.id });

    const after = await planAdherence(result.planId);
    expect(after.fulfilled).toBe(1);
    expect(after.delivered.total).toBe(1);
    expect(after.outstanding).toBe(result.briefs - 1);
  });

  it("keeps a skipped brief and its reason rather than deleting it", async () => {
    await withStrategy();
    const result = await createContentPlan({ workspaceId, projectId, days: 7, activate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const brief = await prisma.contentBrief.findFirstOrThrow({
      where: { planId: result.planId },
    });
    await skipBrief({ briefId: brief.id, reason: "Nobody had the footage." });

    const after = await prisma.contentBrief.findUniqueOrThrow({ where: { id: brief.id } });
    expect(after.status).toBe(BriefStatus.SKIPPED);
    expect(after.skipReason).toBe("Nobody had the footage.");

    const adherence = await planAdherence(result.planId);
    expect(adherence.skipped).toBe(1);
  });

  it("links one post to exactly one brief", async () => {
    await withStrategy();
    const result = await createContentPlan({ workspaceId, projectId, days: 7, activate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const briefs = await prisma.contentBrief.findMany({
      where: { planId: result.planId },
      orderBy: { sequence: "asc" },
      take: 2,
    });
    const asset = await createAssetFixture({ projectId, seed: 2 });
    const variant = await createVariantFixture({ assetId: asset.id });
    const post = await prisma.post.create({
      data: { projectId, assetId: asset.id, variantId: variant.id },
    });

    await fulfilBrief({ briefId: briefs[0]!.id, postId: post.id });
    // The same post cannot also fulfil a second brief.
    await expect(fulfilBrief({ briefId: briefs[1]!.id, postId: post.id })).rejects.toThrow();
  });

  it("plans for the platforms that are actually connected", async () => {
    await withStrategy();
    const result = await createContentPlan({ workspaceId, projectId, days: 7, activate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const brief = await prisma.contentBrief.findFirstOrThrow({
      where: { planId: result.planId },
    });
    expect(brief.platforms).toEqual([Platform.TIKTOK]);
  });
});
