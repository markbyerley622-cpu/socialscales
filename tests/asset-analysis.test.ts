import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  AIProviderKind,
  AssetStatus,
  BriefStatus,
  Confidence,
} from "@/generated/prisma/enums";
import { analyzeAsset, AnalysisFailedError } from "@/server/services/content-service";
import type { ModelProvider } from "@/server/ai/orchestration";
import { createPost } from "@/server/services/post-service";
import { ingestAllKnowledge } from "@/server/knowledge";
import { generateStrategy } from "@/server/strategy";
import {
  attachAssetToBrief,
  createContentPlan,
  detachAssetFromBrief,
  openBriefs,
  planAdherence,
} from "@/server/content-director";
import {
  createAssetFixture,
  createOperator,
  createProjectFixture,
  ensureWorkspace,
  migrateTestSchema,
  resetDatabase,
} from "./helpers";

/**
 * Phase 5: asset ingestion and analysis through the AI boundary.
 *
 * The properties under test: analysis is recorded with its provenance and its
 * limits, an asset claims a brief only when someone says so, and the brief
 * reaches FULFILLED through a real post rather than a guess.
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
  await ingestAllKnowledge({ workspaceId, projectId: null });
});

describe("analysis goes through the boundary", () => {
  it("records the provider, prompt version and job that produced it", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 1 });
    const result = await analyzeAsset({ assetId: asset.id, userId, variantCount: 3 });

    expect(result.usedModel).toBe(false);
    expect(result.variantIds).toHaveLength(3);

    const analysis = await prisma.aIAnalysis.findUniqueOrThrow({
      where: { id: result.analysisId },
    });
    expect(analysis.provider).toBe("deterministic");
    expect(analysis.model).toBeNull();
    expect(analysis.promptVersion).toBe("asset-analysis@1.0.0");
    expect(analysis.aiJobId).not.toBeNull();

    const job = await prisma.aIJob.findUniqueOrThrow({
      where: { id: analysis.aiJobId! },
    });
    expect(job.operation).toBe("ASSET_ANALYSIS");
    expect(job.providerKind).toBe(AIProviderKind.DETERMINISTIC);
  });

  it("leaves one AIJob per step so cost is attributable", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 2 });
    await analyzeAsset({ assetId: asset.id, userId, variantCount: 2 });

    const jobs = await prisma.aIJob.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    expect(jobs.map((job) => job.operation)).toEqual(["ASSET_ANALYSIS", "COPY_VARIANTS"]);
  });

  it("stores what the conclusions rest on and what it could not determine", async () => {
    const asset = await createAssetFixture({
      projectId,
      uploaderId: userId,
      filename: "screen-recording-dashboard-demo.mp4",
      seed: 3,
    });
    const result = await analyzeAsset({ assetId: asset.id, userId });

    const analysis = await prisma.aIAnalysis.findUniqueOrThrow({
      where: { id: result.analysisId },
    });
    expect(analysis.basis.length).toBeGreaterThan(0);
    expect(analysis.unknowns.join(" ")).toContain("media itself");
    // A filename is a weak signal, and the record says so rather than borrowing
    // confidence from the fact that a computer produced the answer.
    expect(analysis.confidence).toBe(Confidence.LOW);
    // It never claims to have heard anything: it has not seen the media.
    expect(analysis.transcript).toBeNull();
  });

  it("appends rather than overwriting, so edited work is never lost", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 4 });
    const first = await analyzeAsset({ assetId: asset.id, userId, variantCount: 2 });
    const second = await analyzeAsset({ assetId: asset.id, userId, variantCount: 2 });

    expect(second.analysisId).not.toBe(first.analysisId);
    expect(await prisma.aIAnalysis.count({ where: { assetId: asset.id } })).toBe(2);
    expect(await prisma.contentVariant.count({ where: { assetId: asset.id } })).toBe(4);

    // Only the very first variant of the first batch is the control.
    const controls = await prisma.contentVariant.findMany({
      where: { assetId: asset.id, isControl: true },
    });
    expect(controls).toHaveLength(1);
    expect(first.variantIds).toContain(controls[0]!.id);
  });

  it("marks the asset failed and surfaces the classified reason", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 5 });

    // A provider that answers with something the schema will not accept.
    const nonsense: ModelProvider = {
      name: "stub-broken",
      kind: AIProviderKind.LLM,
      model: "stub-model-1",
      availability: () => ({ available: true }),
      canServe: () => true,
      async complete() {
        return {
          text: JSON.stringify({ not: "an analysis" }),
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0.001,
          priced: true,
          model: "stub-model-1",
        };
      },
    };

    await expect(
      analyzeAsset({ assetId: asset.id, userId, provider: nonsense }),
    ).rejects.toBeInstanceOf(AnalysisFailedError);

    const after = await prisma.contentAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(after.status).toBe(AssetStatus.ANALYSIS_FAILED);
    // The failed job is still recorded, so a failure is visible rather than silent,
    // and the attempts it paid for are still billed.
    const jobs = await prisma.aIJob.findMany({ where: { projectId } });
    expect(jobs.some((job) => job.status === "INVALID_OUTPUT")).toBe(true);
    expect(jobs.some((job) => job.costUsd > 0)).toBe(true);
    // Nothing unvalidated was written.
    expect(await prisma.aIAnalysis.count({ where: { assetId: asset.id } })).toBe(0);
  });
});

describe("assets and briefs", () => {
  async function withPlan() {
    await prisma.businessObjective.create({
      data: { projectId, kind: "PROFILE_VISITS", kpi: "profileVisits", priority: 1 },
    });
    const strategy = await generateStrategy({ workspaceId, projectId, activate: true });
    if (!strategy.ok) throw new Error(strategy.reason);
    const plan = await createContentPlan({
      workspaceId,
      projectId,
      days: 7,
      activate: true,
    });
    if (!plan.ok) throw new Error(plan.reason);
    return plan;
  }

  it("lists briefs still waiting on an asset as the production queue", async () => {
    const plan = await withPlan();
    const open = await openBriefs(projectId);
    expect(open).toHaveLength(plan.briefs);
    expect(open.every((brief) => brief.assets.length === 0)).toBe(true);
  });

  it("moves a brief into production only when an asset claims it", async () => {
    await withPlan();
    const brief = await prisma.contentBrief.findFirstOrThrow({
      where: { projectId },
      orderBy: { sequence: "asc" },
    });
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 6 });

    // Nothing is inferred from timing or pillar: until it is claimed, it is not linked.
    expect(
      (await prisma.contentBrief.findUniqueOrThrow({ where: { id: brief.id } })).status,
    ).toBe(BriefStatus.PLANNED);

    await attachAssetToBrief({ assetId: asset.id, briefId: brief.id });
    const after = await prisma.contentBrief.findUniqueOrThrow({ where: { id: brief.id } });
    expect(after.status).toBe(BriefStatus.IN_PRODUCTION);
  });

  it("marks a brief READY once its asset has been analysed", async () => {
    await withPlan();
    const brief = await prisma.contentBrief.findFirstOrThrow({
      where: { projectId },
      orderBy: { sequence: "asc" },
    });
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 7 });
    await attachAssetToBrief({ assetId: asset.id, briefId: brief.id });
    await analyzeAsset({ assetId: asset.id, userId, variantCount: 1 });

    const after = await prisma.contentBrief.findUniqueOrThrow({ where: { id: brief.id } });
    expect(after.status).toBe(BriefStatus.READY);
  });

  it("closes the loop: publishing an asset fulfils its brief", async () => {
    const plan = await withPlan();
    const brief = await prisma.contentBrief.findFirstOrThrow({
      where: { projectId },
      orderBy: { sequence: "asc" },
    });
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 8 });
    await attachAssetToBrief({ assetId: asset.id, briefId: brief.id });
    const analysed = await analyzeAsset({ assetId: asset.id, userId, variantCount: 1 });

    const account = await prisma.socialAccount.findFirstOrThrow({ where: { projectId } });
    const post = await createPost({
      projectId,
      assetId: asset.id,
      variantId: analysed.variantIds[0]!,
      socialAccountIds: [account.id],
      userId,
      scheduledFor: new Date(Date.now() + 3_600_000),
    });

    const after = await prisma.contentBrief.findUniqueOrThrow({ where: { id: brief.id } });
    expect(after.status).toBe(BriefStatus.FULFILLED);
    expect(after.postId).toBe(post.postId);

    const adherence = await planAdherence(plan.planId);
    expect(adherence.fulfilled).toBe(1);
  });

  it("refuses to attach an asset to another project's brief", async () => {
    await withPlan();
    const brief = await prisma.contentBrief.findFirstOrThrow({ where: { projectId } });
    const other = await createProjectFixture({ workspaceId, slug: "other-project" });
    const asset = await createAssetFixture({ projectId: other.id, seed: 9 });

    await expect(
      attachAssetToBrief({ assetId: asset.id, briefId: brief.id }),
    ).rejects.toThrow(/same project/);
  });

  it("does not walk a fulfilled brief backwards when another asset is attached", async () => {
    await withPlan();
    const brief = await prisma.contentBrief.findFirstOrThrow({
      where: { projectId },
      orderBy: { sequence: "asc" },
    });
    const first = await createAssetFixture({ projectId, uploaderId: userId, seed: 10 });
    await attachAssetToBrief({ assetId: first.id, briefId: brief.id });
    const analysed = await analyzeAsset({ assetId: first.id, userId, variantCount: 1 });

    const account = await prisma.socialAccount.findFirstOrThrow({ where: { projectId } });
    await createPost({
      projectId,
      assetId: first.id,
      variantId: analysed.variantIds[0]!,
      socialAccountIds: [account.id],
      userId,
      scheduledFor: new Date(Date.now() + 3_600_000),
    });

    const second = await createAssetFixture({ projectId, uploaderId: userId, seed: 11 });
    await attachAssetToBrief({ assetId: second.id, briefId: brief.id });

    const after = await prisma.contentBrief.findUniqueOrThrow({ where: { id: brief.id } });
    expect(after.status).toBe(BriefStatus.FULFILLED);
  });

  it("detaches without deleting either side", async () => {
    await withPlan();
    const brief = await prisma.contentBrief.findFirstOrThrow({ where: { projectId } });
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 12 });
    await attachAssetToBrief({ assetId: asset.id, briefId: brief.id });
    await detachAssetFromBrief(asset.id);

    const after = await prisma.contentAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(after.briefId).toBeNull();
    expect(await prisma.contentBrief.count({ where: { id: brief.id } })).toBe(1);
  });
});
