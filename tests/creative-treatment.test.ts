import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { AIProviderKind } from "@/generated/prisma/enums";
import { analyzeAsset } from "@/server/services/content-service";
import {
  offBriefVariants,
  readBeats,
  writeTreatment,
} from "@/server/services/treatment-service";
import { ingestAllKnowledge } from "@/server/knowledge";
import { generateStrategy } from "@/server/strategy";
import { attachAssetToBrief, createContentPlan } from "@/server/content-director";
import { creativeTreatmentPrompt } from "@/server/ai/orchestration";
import type {
  CreativeTreatmentOutput,
  ModelProvider,
  ModelResponse,
  TreatmentInput,
} from "@/server/ai/orchestration";
import {
  createAssetFixture,
  createOperator,
  createProjectFixture,
  createVariantFixture,
  ensureWorkspace,
  migrateTestSchema,
  resetDatabase,
} from "./helpers";

/**
 * Phase 6: creative treatments.
 *
 * A treatment is the thing that makes a variant shootable, and the claim that
 * matters is `deliversKeyMessage` — a brief commissions a piece to say a
 * particular thing, and a treatment that does not say it is a different piece
 * wearing the brief's name. These tests are mostly about that claim being
 * checkable rather than assertable.
 */

let workspaceId: string;
let projectId: string;
let userId: string;

beforeAll(async () => {
  await migrateTestSchema();
});

beforeEach(async () => {
  await resetDatabase();
  workspaceId = (await ensureWorkspace()).id;
  const project = await createProjectFixture({ workspaceId });
  projectId = project.id;
  userId = (await createOperator()).id;
  await prisma.businessObjective.create({
    data: { projectId, kind: "PROFILE_VISITS", kpi: "profileVisits", priority: 1 },
  });
  await ingestAllKnowledge({ workspaceId, projectId: null });
});

function treatmentProvider(payload: unknown | unknown[]): ModelProvider {
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
        usage: { inputTokens: 800, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.02,
        priced: true,
        model: "stub-model-1",
      };
    },
  };
}

/** An asset with a brief behind it, and one variant to treat. */
async function briefedVariant() {
  const strategy = await generateStrategy({ workspaceId, projectId, activate: true });
  if (!strategy.ok) throw new Error(strategy.reason);
  const plan = await createContentPlan({ workspaceId, projectId, days: 7, activate: true });
  if (!plan.ok) throw new Error(plan.reason);

  const brief = await prisma.contentBrief.findFirstOrThrow({
    where: { projectId },
    orderBy: { sequence: "asc" },
  });
  const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 1 });
  await attachAssetToBrief({ assetId: asset.id, briefId: brief.id });
  const analysed = await analyzeAsset({ assetId: asset.id, userId, variantCount: 1 });

  return { brief, asset, variantId: analysed.variantIds[0]! };
}

/** The context the prompt would be given, so a test can build a valid draft. */
async function contextFor(variantId: string): Promise<TreatmentInput> {
  const variant = await prisma.contentVariant.findUniqueOrThrow({
    where: { id: variantId },
    include: { asset: { include: { brief: true } } },
  });
  const brand = await prisma.brand.findUniqueOrThrow({
    where: { projectId: variant.asset.projectId },
  });
  return {
    brief: variant.asset.brief
      ? {
          workingTitle: variant.asset.brief.workingTitle,
          angle: variant.asset.brief.angle,
          keyMessage: variant.asset.brief.keyMessage,
          format: variant.asset.brief.format,
          hookFamily: variant.asset.brief.hookFamily,
          minSeconds: variant.asset.brief.minSeconds,
          maxSeconds: variant.asset.brief.maxSeconds,
          productionNotes: variant.asset.brief.productionNotes,
        }
      : null,
    variant: {
      label: variant.label,
      hook: variant.hook,
      caption: variant.caption,
      cta: variant.cta,
    },
    asset: {
      title: variant.asset.title,
      kind: variant.asset.kind,
      durationSeconds: variant.asset.durationSeconds,
      aspectRatio: variant.asset.aspectRatio,
      hasAudio: variant.asset.hasAudio,
    },
    brand: {
      tone: brand.tone,
      audience: brand.audience,
      valueProp: brand.valueProp,
      primaryCta: brand.primaryCta,
      bannedPhrases: brand.bannedPhrases,
      prohibitedTopics: brand.prohibitedTopics,
    },
    narrativeStructures: [],
  };
}

describe("a treatment makes a variant shootable", () => {
  it("writes ordered, timed beats with no model", async () => {
    const { variantId } = await briefedVariant();
    const result = await writeTreatment({ variantId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.provenance.deterministic).toBe(true);

    const variant = await prisma.contentVariant.findUniqueOrThrow({ where: { id: variantId } });
    const beats = readBeats(variant.treatment);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[0]?.startSeconds).toBe(0);
    for (let index = 1; index < beats.length; index += 1) {
      expect(beats[index]!.startSeconds).toBeGreaterThanOrEqual(beats[index - 1]!.endSeconds);
    }
    expect(variant.ctaPlacement).toBe("END");
    expect(variant.generatedBy).toBe("deterministic");
    expect(variant.model).toBeNull();
    expect(variant.promptVersion).toBe("creative-treatment@1.0.0");
    expect(variant.aiJobId).not.toBeNull();
  });

  it("opens on the hook rather than a title card", async () => {
    const { variantId } = await briefedVariant();
    await writeTreatment({ variantId });

    const variant = await prisma.contentVariant.findUniqueOrThrow({ where: { id: variantId } });
    const beats = readBeats(variant.treatment);
    expect(beats[0]?.voiceover).toBe(variant.hook);
    expect(beats[0]?.shot.toLowerCase()).toContain("no title card");
  });

  it("fits the brief's length range", async () => {
    const { brief, variantId } = await briefedVariant();
    await writeTreatment({ variantId });

    const variant = await prisma.contentVariant.findUniqueOrThrow({ where: { id: variantId } });
    const beats = readBeats(variant.treatment);
    const total = beats[beats.length - 1]!.endSeconds;
    if (brief.minSeconds !== null) expect(total).toBeGreaterThanOrEqual(brief.minSeconds);
    if (brief.maxSeconds !== null) expect(total).toBeLessThanOrEqual(brief.maxSeconds);
  });
});

describe("the key-message claim is checked, not trusted", () => {
  it("delivers the brief's key message by construction", async () => {
    const { brief, variantId } = await briefedVariant();
    const result = await writeTreatment({ variantId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliversKeyMessage).toBe(true);
    expect(result.keyMessageNote).toContain(brief.keyMessage.slice(0, 30));
  });

  it("rejects a treatment that claims delivery while covering something else", async () => {
    const { variantId } = await briefedVariant();
    const context = await contextFor(variantId);
    const valid = creativeTreatmentPrompt.deterministic(context) as CreativeTreatmentOutput;

    const lying: CreativeTreatmentOutput = {
      ...valid,
      beats: valid.beats.map((beat) => ({
        ...beat,
        shot: "Footage of unrelated scenery, wide angle.",
        onScreenText: null,
        voiceover: null,
      })),
      deliversKeyMessage: true,
      keyMessageNote: "The message comes across, broadly speaking.",
    };

    const result = await writeTreatment({
      variantId,
      provider: treatmentProvider(lying),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no beat carries the key message");
  });

  it("accepts an honest false, because a missed message is an editorial call", async () => {
    const { variantId } = await briefedVariant();
    const context = await contextFor(variantId);
    const valid = creativeTreatmentPrompt.deterministic(context) as CreativeTreatmentOutput;

    const honest: CreativeTreatmentOutput = {
      ...valid,
      deliversKeyMessage: false,
      keyMessageNote:
        "No beat states the key message; this treatment leads with the demo instead.",
    };

    const result = await writeTreatment({ variantId, provider: treatmentProvider(honest) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliversKeyMessage).toBe(false);

    // And it is surfaced rather than blocked.
    const off = await offBriefVariants(projectId);
    expect(off.map((entry) => entry.id)).toContain(variantId);
  });

  it("refuses a delivery claim when there is no brief to deliver against", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 2 });
    const variant = await createVariantFixture({ assetId: asset.id });
    const context = await contextFor(variant.id);
    expect(context.brief).toBeNull();

    const valid = creativeTreatmentPrompt.deterministic(context) as CreativeTreatmentOutput;
    // The rules already answer false here; a model claiming true is rejected.
    expect(valid.deliversKeyMessage).toBe(false);

    const result = await writeTreatment({
      variantId: variant.id,
      provider: treatmentProvider({ ...valid, deliversKeyMessage: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no brief");
  });
});

describe("structural rules", () => {
  async function draft(overrides: Partial<CreativeTreatmentOutput> = {}) {
    const { variantId } = await briefedVariant();
    const context = await contextFor(variantId);
    const valid = creativeTreatmentPrompt.deterministic(context) as CreativeTreatmentOutput;
    return { variantId, draft: { ...valid, ...overrides } };
  }

  it("rejects overlapping beats", async () => {
    const { variantId, draft: base } = await draft();
    const overlapped: CreativeTreatmentOutput = {
      ...base,
      beats: base.beats.map((beat, index) =>
        index === 1 ? { ...beat, startSeconds: 0 } : beat,
      ),
    };
    const result = await writeTreatment({
      variantId,
      provider: treatmentProvider(overlapped),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("overlaps the previous beat");
  });

  it("rejects an empty string where silence was meant", async () => {
    const { variantId, draft: base } = await draft();
    const blank: CreativeTreatmentOutput = {
      ...base,
      beats: base.beats.map((beat, index) =>
        index === 1 ? { ...beat, onScreenText: "   " } : beat,
      ),
    };
    const result = await writeTreatment({ variantId, provider: treatmentProvider(blank) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("use null for no text");
  });

  it("rejects a treatment that says a banned phrase on screen", async () => {
    await prisma.brand.update({
      where: { projectId },
      data: { bannedPhrases: ["guaranteed results"] },
    });
    const { variantId, draft: base } = await draft();
    const banned: CreativeTreatmentOutput = {
      ...base,
      beats: base.beats.map((beat, index) =>
        index === 0 ? { ...beat, onScreenText: "Guaranteed results, fast" } : beat,
      ),
    };
    const result = await writeTreatment({ variantId, provider: treatmentProvider(banned) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("banned phrase");
  });

  it("rejects a hook family the brief did not commission", async () => {
    const { variantId, draft: base } = await draft({ hookFamily: "something-else" });
    const brief = await prisma.contentBrief.findFirstOrThrow({
      where: { projectId },
      orderBy: { sequence: "asc" },
    });
    if (!brief.hookFamily) return; // nothing to violate

    const result = await writeTreatment({ variantId, provider: treatmentProvider(base) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("commissioned");
  });

  it("repairs a bad treatment rather than failing outright", async () => {
    const { variantId, draft: good } = await draft();
    const bad: CreativeTreatmentOutput = {
      ...good,
      beats: good.beats.map((beat, index) =>
        index === 1 ? { ...beat, startSeconds: 0 } : beat,
      ),
    };
    const result = await writeTreatment({
      variantId,
      provider: treatmentProvider([bad, good]),
    });
    expect(result.ok).toBe(true);
    expect(result.job.repairAttempts).toBe(1);
  });

  it("leaves the variant untouched when the treatment is rejected", async () => {
    const { variantId, draft: base } = await draft();
    const before = await prisma.contentVariant.findUniqueOrThrow({ where: { id: variantId } });

    const broken: CreativeTreatmentOutput = {
      ...base,
      beats: base.beats.map((beat, index) =>
        index === 1 ? { ...beat, startSeconds: 0 } : beat,
      ),
    };
    await writeTreatment({ variantId, provider: treatmentProvider(broken) });

    const after = await prisma.contentVariant.findUniqueOrThrow({ where: { id: variantId } });
    expect(after.treatment).toEqual(before.treatment);
    expect(after.hook).toBe(before.hook);
  });
});
