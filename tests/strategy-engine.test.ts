import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  AIProviderKind,
  Confidence,
  EvidenceType,
  StrategyStatus,
} from "@/generated/prisma/enums";
import { recordEvidence } from "@/server/intelligence/evidence";
import { ingestAllKnowledge } from "@/server/knowledge";
import {
  activateStrategy,
  buildStrategyContext,
  collectEvidenceLinks,
  generateStrategy,
  strategyRationale,
} from "@/server/strategy";
import { strategyDraftPrompt } from "@/server/ai/orchestration";
import type { ModelProvider, ModelResponse } from "@/server/ai/orchestration";
import {
  createProjectFixture,
  ensureWorkspace,
  migrateTestSchema,
  resetDatabase,
} from "./helpers";

/**
 * Phase 3: the strategy engine.
 *
 * What is tested is the things that would let a strategy be dishonest: citing
 * evidence that does not exist, claiming confidence the account has not earned,
 * losing the link between a decision and its basis, or editing history.
 */

let workspaceId: string;
let projectId: string;

beforeAll(async () => {
  await migrateTestSchema();
});

beforeEach(async () => {
  await resetDatabase();
  const workspace = await ensureWorkspace();
  workspaceId = workspace.id;
  const project = await createProjectFixture({ workspaceId });
  projectId = project.id;

  await prisma.businessObjective.create({
    data: {
      projectId,
      kind: "PROFILE_VISITS",
      kpi: "profileVisits",
      priority: 1,
      optimizationWeight: 3,
      attributionLimitations: "TikTok gives no click attribution.",
    },
  });
  await prisma.businessObjective.create({
    data: { projectId, kind: "FOLLOWERS", kpi: "followerDelta", priority: 2 },
  });
  await prisma.audienceSegment.create({
    data: {
      projectId,
      name: "Indie builders",
      awarenessStage: "PROBLEM_AWARE",
      priority: 1,
      pains: ["shipping takes too long"],
      desires: ["ship faster"],
    },
  });

  await ingestAllKnowledge({ workspaceId, projectId: null });
});

/** A stub that returns whatever draft the test wants to see handled. */
function draftProvider(
  payload: unknown | unknown[],
  kind: AIProviderKind = AIProviderKind.LLM,
): ModelProvider {
  const script = Array.isArray(payload) ? payload : [payload];
  let index = 0;
  return {
    name: "stub-strategist",
    kind,
    model: kind === AIProviderKind.LLM ? "stub-model-1" : null,
    availability: () => ({ available: true }),
    canServe: () => true,
    async complete(): Promise<ModelResponse> {
      const next = script[Math.min(index, script.length - 1)];
      index += 1;
      return {
        text: JSON.stringify(next),
        usage: { inputTokens: 900, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.015,
        priced: true,
        model: kind === AIProviderKind.LLM ? "stub-model-1" : null,
      };
    },
  };
}

async function context() {
  return buildStrategyContext({ workspaceId, projectId });
}

describe("strategy context", () => {
  it("reports a cold start honestly instead of implying history", async () => {
    const built = await context();
    expect(built.accountState.cold).toBe(true);
    expect(built.accountState.accountObservations).toBe(0);
    expect(built.accountState.reason).toContain("No observations from this account");
  });

  it("ranks dimension options and marks the prior-only ones", async () => {
    const built = await context();
    const hooks = built.dimensions.find((digest) => digest.dimension === "hook");
    expect(hooks?.options.length).toBeGreaterThan(0);
    expect(hooks?.options.every((option) => option.priorOnly)).toBe(true);
    expect(hooks?.headline).toContain("general priors only");
  });

  it("outranks a prior once the account has its own evidence", async () => {
    await recordEvidence({
      workspaceId,
      projectId,
      type: EvidenceType.ACCOUNT_EVIDENCE,
      sourceEntityType: "PostPlatform",
      claim: "Numeric hooks did better here.",
      dimension: "hook",
      groupKey: "numeric",
      metric: "profileVisits",
      effectSize: 0.4,
      sampleSize: 20,
      confidence: 0.8,
    });

    const built = await context();
    const hooks = built.dimensions.find((digest) => digest.dimension === "hook");
    expect(hooks?.options[0]?.groupKey).toBe("numeric");
    expect(hooks?.options[0]?.priorOnly).toBe(false);
    expect(hooks?.options[0]?.classes).toContain(EvidenceType.ACCOUNT_EVIDENCE);
  });

  it("lists exactly the evidence ids a strategy may cite", async () => {
    const built = await context();
    const fromDimensions = new Set(
      built.dimensions.flatMap((digest) => digest.options.flatMap((o) => o.evidenceIds)),
    );
    expect(new Set(built.citableEvidenceIds)).toEqual(fromDimensions);
    expect(built.citableEvidenceIds.length).toBeGreaterThan(0);
  });
});

describe("generation from rules alone", () => {
  it("produces a complete, valid strategy with no model", async () => {
    const result = await generateStrategy({ workspaceId, projectId, activate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.job.provenance.deterministic).toBe(true);
    expect(result.version).toBe(1);

    const strategy = await prisma.strategyVersion.findUniqueOrThrow({
      where: { id: result.strategyId },
      include: { targetAudience: true, evidence: true },
    });

    expect(strategy.status).toBe(StrategyStatus.ACTIVE);
    expect(strategy.targetAudience?.name).toBe("Indie builders");
    expect(strategy.hookFamilies.length).toBeGreaterThan(0);
    expect(strategy.evidence.length).toBeGreaterThan(0);
    expect(strategy.generatedBy).toBe("deterministic");
    expect(strategy.model).toBeNull();
    expect(strategy.promptVersion).toBe("strategy-draft@1.0.0");
  });

  it("caps a cold-start strategy at LOW confidence", async () => {
    const result = await generateStrategy({ workspaceId, projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strategy = await prisma.strategyVersion.findUniqueOrThrow({
      where: { id: result.strategyId },
    });
    expect(strategy.confidence).toBe(Confidence.LOW);
    const risks = strategy.risks as Array<{ risk: string }>;
    expect(risks.some((entry) => entry.risk.includes("general priors"))).toBe(true);
  });

  it("snapshots the account state it planned from", async () => {
    const result = await generateStrategy({ workspaceId, projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strategy = await prisma.strategyVersion.findUniqueOrThrow({
      where: { id: result.strategyId },
    });
    const state = strategy.accountState as { cold: boolean; publishedPosts: number };
    expect(state.cold).toBe(true);
    expect(state.publishedPosts).toBe(0);
  });

  it("names the unmeasurable objective as a risk rather than optimising blindly", async () => {
    const result = await generateStrategy({ workspaceId, projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strategy = await prisma.strategyVersion.findUniqueOrThrow({
      where: { id: result.strategyId },
    });
    const risks = strategy.risks as Array<{ risk: string }>;
    expect(risks.some((entry) => entry.risk.includes("no click attribution"))).toBe(true);
  });
});

describe("honesty constraints", () => {
  async function validDraft(overrides: Record<string, unknown> = {}) {
    const built = await context();
    const base = await strategyDraftPrompt.deterministic(built);
    return { ...base, ...overrides };
  }

  it("rejects a strategy that cites evidence which does not exist", async () => {
    const draft = await validDraft({
      hypotheses: [
        {
          claim: "Numeric hooks are the way forward for this brand.",
          dimension: "hook",
          howToTest: "Publish six numeric hooks and compare profile visits.",
          basedOn: ["evidence-that-was-never-supplied"],
        },
      ],
    });

    const result = await generateStrategy({
      workspaceId,
      projectId,
      provider: draftProvider(draft),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("INVALID_OUTPUT");
      expect(result.reason).toContain("not an id");
    }
    // A rejected draft writes no strategy at all.
    expect(await prisma.strategyVersion.count({ where: { projectId } })).toBe(0);
  });

  it("repairs an invented citation rather than failing outright", async () => {
    const built = await context();
    const good = await strategyDraftPrompt.deterministic(built);
    const bad = {
      ...good,
      hypotheses: [
        {
          claim: "A fabricated basis for a plausible-sounding claim.",
          dimension: "hook",
          howToTest: "Publish six posts and compare.",
          basedOn: ["made-up-id"],
        },
      ],
    };

    const result = await generateStrategy({
      workspaceId,
      projectId,
      provider: draftProvider([bad, good]),
    });

    expect(result.ok).toBe(true);
    expect(result.job.repairAttempts).toBe(1);
  });

  it("rejects confidence the account has not earned", async () => {
    const draft = await validDraft({ confidence: "HIGH" });
    const result = await generateStrategy({
      workspaceId,
      projectId,
      provider: draftProvider(draft),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("supports at most LOW");
  });

  it("rejects an audience this brand does not have", async () => {
    const draft = await validDraft({ targetAudienceName: "Fortune 500 CTOs" });
    const result = await generateStrategy({
      workspaceId,
      projectId,
      provider: draftProvider(draft),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not one of this brand's audiences");
  });

  it("rejects an objective this brand does not track", async () => {
    const draft = await validDraft({ primaryObjectiveKpi: "revenuePerUser" });
    const result = await generateStrategy({
      workspaceId,
      projectId,
      provider: draftProvider(draft),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not a defined objective");
  });

  it("rejects a format that is not a real format", async () => {
    const draft = await validDraft({ recommendedFormats: ["VIRAL_BANGER"] });
    const result = await generateStrategy({
      workspaceId,
      projectId,
      provider: draftProvider(draft),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not valid formats");
  });

  it("allows an explicitly untested hypothesis", async () => {
    const draft = await validDraft({
      hypotheses: [
        {
          claim: "Longer captions might suit this audience, but nothing supports that yet.",
          dimension: "length",
          howToTest: "Publish a matched pair and compare completion rate.",
          basedOn: [],
        },
      ],
    });

    const result = await generateStrategy({
      workspaceId,
      projectId,
      provider: draftProvider(draft),
    });
    expect(result.ok).toBe(true);
  });
});

describe("traceability", () => {
  it("links each decision to the evidence behind it, with real strengths", async () => {
    const result = await generateStrategy({ workspaceId, projectId, activate: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rationale = await strategyRationale(result.strategyId);
    const decisions = rationale.decisions.map((entry) => entry.decision);
    expect(decisions).toContain("hookFamilies");

    const hookDecision = rationale.decisions.find((d) => d.decision === "hookFamilies")!;
    expect(hookDecision.links.length).toBeGreaterThan(0);
    // Strength is the weight the decision was actually made from, not a label.
    expect(hookDecision.links.every((link) => link.strength > 0)).toBe(true);
    expect(hookDecision.priorOnly).toBe(true);
    expect(hookDecision.classes[EvidenceType.GLOBAL_PRIOR]).toBeGreaterThan(0);
  });

  it("attributes decisions to the option the strategy actually chose", async () => {
    const built = await context();
    const links = collectEvidenceLinks(built, {
      hookFamilies: ["numeric"],
      recommendedFormats: [],
      hypotheses: [],
    });
    const numericIds = built.dimensions
      .find((digest) => digest.dimension === "hook")!
      .options.find((option) => option.groupKey === "numeric")!.evidenceIds;

    expect(links.map((link) => link.evidenceSourceId).sort()).toEqual([...numericIds].sort());
    expect(links.every((link) => link.decision === "hookFamilies")).toBe(true);
  });
});

describe("versioning", () => {
  it("supersedes rather than edits, keeping the old version readable", async () => {
    const first = await generateStrategy({ workspaceId, projectId, activate: true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await generateStrategy({ workspaceId, projectId, activate: true });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.version).toBe(2);

    const [older, newer] = await Promise.all([
      prisma.strategyVersion.findUniqueOrThrow({ where: { id: first.strategyId } }),
      prisma.strategyVersion.findUniqueOrThrow({ where: { id: second.strategyId } }),
    ]);

    expect(older.status).toBe(StrategyStatus.SUPERSEDED);
    expect(older.supersededById).toBe(newer.id);
    expect(newer.status).toBe(StrategyStatus.ACTIVE);
    // The old summary is untouched — history is not rewritten.
    expect(older.summary.length).toBeGreaterThan(0);
  });

  it("leaves the active strategy alone when a new draft is not activated", async () => {
    const first = await generateStrategy({ workspaceId, projectId, activate: true });
    const second = await generateStrategy({ workspaceId, projectId });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const older = await prisma.strategyVersion.findUniqueOrThrow({
      where: { id: first.strategyId },
    });
    expect(older.status).toBe(StrategyStatus.ACTIVE);

    await activateStrategy(second.strategyId);
    const afterOld = await prisma.strategyVersion.findUniqueOrThrow({
      where: { id: first.strategyId },
    });
    const afterNew = await prisma.strategyVersion.findUniqueOrThrow({
      where: { id: second.strategyId },
    });
    expect(afterOld.status).toBe(StrategyStatus.SUPERSEDED);
    expect(afterNew.status).toBe(StrategyStatus.ACTIVE);
  });

  it("records the provider and prompt version that produced each strategy", async () => {
    const built = await context();
    const draft = await strategyDraftPrompt.deterministic(built);
    const result = await generateStrategy({
      workspaceId,
      projectId,
      provider: draftProvider(draft),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strategy = await prisma.strategyVersion.findUniqueOrThrow({
      where: { id: result.strategyId },
    });
    expect(strategy.generatedBy).toBe("stub-strategist");
    expect(strategy.model).toBe("stub-model-1");
    expect(strategy.promptVersion).toBe("strategy-draft@1.0.0");
  });
});
