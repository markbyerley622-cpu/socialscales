import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  AssetOrigin,
  DistributionFit,
  DistributionRoute,
  DistributionStatus,
  Platform,
  PostStatus,
} from "@/generated/prisma/enums";
import {
  assessDistribution,
  assessTarget,
  dispatchAutomated,
  distributionsForVariant,
  exportForManualUpload,
  optimizeForPlatform,
  trimEdlToBudget,
  undistributedRenders,
} from "@/server/distribution";
import { getAdapter } from "@/server/platforms/registry";
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
 * Phase 8: distribution.
 *
 * The chain is an approved render -> per-platform assessment -> either the
 * existing automated publish path or a person with a file and a caption. What is
 * protected here is that a cut never leaves the building for a destination that
 * will not take it, and that a manual upload says the same thing an automated
 * one would.
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
  const project = await createProjectFixture({
    workspaceId,
    platforms: [Platform.TIKTOK, Platform.YOUTUBE],
  });
  projectId = project.id;
  userId = (await createOperator()).id;
});

/**
 * A rendered cut with the shape Phase 7 actually produces: source footage, a
 * variant belonging to that source, and a *separate* output asset joined to
 * both by a render job.
 *
 * Modelling this properly matters. An earlier version of this fixture hung the
 * variant straight off the cut, which is not a shape the system ever creates —
 * and it hid a real failure in the automated route, because `createPost`
 * requires the variant to belong to the asset unless a render job says
 * otherwise.
 */
async function renderedCut(options: { seconds?: number; sizeBytes?: number } = {}) {
  const source = await createAssetFixture({ projectId, uploaderId: userId, seed: 1 });
  const variant = await createVariantFixture({ assetId: source.id });

  const output = await createAssetFixture({ projectId, uploaderId: userId, seed: 2 });
  const cut = await prisma.contentAsset.update({
    where: { id: output.id },
    data: {
      origin: AssetOrigin.RENDER,
      durationSeconds: options.seconds ?? 24,
      sizeBytes: options.sizeBytes ?? 2_000_000,
      width: 1080,
      height: 1920,
      aspectRatio: "9:16",
      mimeType: "video/mp4",
    },
  });

  await prisma.renderJob.create({
    data: {
      projectId,
      variantId: variant.id,
      idempotencyKey: `fixture-${cut.id}`,
      status: "SUCCEEDED",
      stage: "DONE",
      config: {},
      sourceAssetIds: [source.id],
      outputAssetId: cut.id,
      outputKey: cut.storageKey,
    },
  });

  return { cut, variant, source };
}

describe("assessing a cut against a platform", () => {
  it("passes a 9:16 H.264 cut that is within every limit", () => {
    const assessment = assessTarget({
      platform: Platform.TIKTOK,
      asset: {
        mimeType: "video/mp4",
        sizeBytes: 2_000_000,
        durationSeconds: 24,
        aspectRatio: "9:16",
      },
      variant: { caption: "A caption.", hashtags: ["#a"], cta: "Link in bio" },
    });
    expect(assessment.fit).toBe(DistributionFit.READY);
    expect(assessment.optimization).toBeNull();
    expect(assessment.automatable).toBe(true);
  });

  it("marks an over-long cut as fixable by re-rendering, not blocked", () => {
    const max = getAdapter(Platform.TIKTOK).constraints.maxDurationSeconds!;
    const assessment = assessTarget({
      platform: Platform.TIKTOK,
      asset: {
        mimeType: "video/mp4",
        sizeBytes: 2_000_000,
        durationSeconds: max + 120,
        aspectRatio: "9:16",
      },
      variant: { caption: "A caption.", hashtags: [], cta: "Link in bio" },
    });
    expect(assessment.fit).toBe(DistributionFit.NEEDS_OPTIMIZATION);
    expect(assessment.optimization?.kind).toBe("TRIM");
    expect(assessment.optimization!.targetSeconds).toBeLessThan(max);
  });

  it("blocks a cut whose problem re-rendering cannot fix", () => {
    const assessment = assessTarget({
      platform: Platform.TIKTOK,
      asset: {
        mimeType: "video/x-msvideo",
        sizeBytes: 2_000_000,
        durationSeconds: 24,
        aspectRatio: "9:16",
      },
      variant: { caption: "A caption.", hashtags: [], cta: "Link in bio" },
    });
    // Trimming an AVI produces a shorter AVI.
    expect(assessment.fit).toBe(DistributionFit.BLOCKED);
    expect(assessment.optimization).toBeNull();
  });

  it("composes the caption the way that platform wants it", () => {
    const assessment = assessTarget({
      platform: Platform.TIKTOK,
      asset: {
        mimeType: "video/mp4",
        sizeBytes: 2_000_000,
        durationSeconds: 24,
        aspectRatio: "9:16",
      },
      variant: {
        caption: "The body of the caption.",
        hashtags: ["#one", "#two"],
        cta: "Link in bio",
      },
    });
    expect(assessment.caption).toContain("The body of the caption.");
    expect(assessment.caption).toContain("Link in bio");
    expect(assessment.caption).toContain("#one");
  });

  it("truncates hashtags to the platform's own maximum", () => {
    const max = getAdapter(Platform.TIKTOK).constraints.hashtagMaxCount;
    const assessment = assessTarget({
      platform: Platform.TIKTOK,
      asset: {
        mimeType: "video/mp4",
        sizeBytes: 2_000_000,
        durationSeconds: 24,
        aspectRatio: "9:16",
      },
      variant: {
        caption: "A caption.",
        hashtags: Array.from({ length: max + 5 }, (_, index) => `#tag${index}`),
        cta: "Link in bio",
      },
    });
    expect(assessment.hashtags).toHaveLength(max);
  });
});

describe("recording an assessment", () => {
  it("writes one row per connected platform", async () => {
    const { cut: asset, variant } = await renderedCut();

    const result = await assessDistribution({ assetId: asset.id, variantId: variant.id });
    expect(result.targets.map((target) => target.platform).sort()).toEqual(
      [Platform.TIKTOK, Platform.YOUTUBE].sort(),
    );

    const rows = await distributionsForVariant(variant.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === DistributionStatus.ASSESSED)).toBe(true);
  });

  it("updates the existing row rather than accumulating opinions", async () => {
    const { cut: asset, variant } = await renderedCut();

    await assessDistribution({ assetId: asset.id, variantId: variant.id });
    await assessDistribution({ assetId: asset.id, variantId: variant.id });

    expect(await prisma.distribution.count({ where: { assetId: asset.id } })).toBe(2);
  });

  it("does not walk back a destination that already went out", async () => {
    const { cut: asset, variant } = await renderedCut();
    await assessDistribution({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
    });

    await dispatchAutomated({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
      userId,
      scheduledFor: new Date(Date.now() + 3_600_000),
    });

    // Re-assessing refreshes the fit but must not un-dispatch it.
    await assessDistribution({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
    });

    const row = await prisma.distribution.findFirstOrThrow({
      where: { assetId: asset.id, platform: Platform.TIKTOK },
    });
    expect(row.status).toBe(DistributionStatus.DISPATCHED);
    expect(row.postId).not.toBeNull();
  });

  it("lists rendered cuts nobody has assessed yet", async () => {
    const { cut: asset, variant } = await renderedCut();
    expect((await undistributedRenders(projectId)).map((row) => row.id)).toContain(
      asset.id,
    );

    await assessDistribution({ assetId: asset.id, variantId: variant.id });

    expect((await undistributedRenders(projectId)).map((row) => row.id)).not.toContain(
      asset.id,
    );
  });
});

describe("the automated route", () => {
  it("hands the cut to the existing publish path", async () => {
    const { cut: asset, variant } = await renderedCut();
    await assessDistribution({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
    });

    const when = new Date(Date.now() + 3_600_000);
    const result = await dispatchAutomated({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
      userId,
      scheduledFor: when,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // An ordinary Post on the rendered asset — nothing bespoke.
    const post = await prisma.post.findUniqueOrThrow({
      where: { id: result.postId },
      include: { targets: true },
    });
    expect(post.assetId).toBe(asset.id);
    expect(post.variantId).toBe(variant.id);
    expect(post.targets.map((target) => target.platform)).toEqual([Platform.TIKTOK]);
    expect(post.status).not.toBe(PostStatus.DRAFT);

    const row = await prisma.distribution.findFirstOrThrow({
      where: { assetId: asset.id, platform: Platform.TIKTOK },
    });
    expect(row.status).toBe(DistributionStatus.DISPATCHED);
    expect(row.route).toBe(DistributionRoute.AUTOMATED);
    expect(row.postId).toBe(result.postId);
    expect(row.dispatchedAt).not.toBeNull();
  });

  it("publishes a cut using the variant it was rendered from", async () => {
    // The variant belongs to the source footage, not to the cut. Only the
    // render job connects them, and createPost has to accept that pairing —
    // this is the one place Phase 7 reaches into the publishing subsystem.
    const { cut, variant, source } = await renderedCut();
    expect(variant.assetId).toBe(source.id);
    expect(cut.id).not.toBe(source.id);

    await assessDistribution({
      assetId: cut.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
    });
    const result = await dispatchAutomated({
      assetId: cut.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
      userId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const post = await prisma.post.findUniqueOrThrow({ where: { id: result.postId } });
    expect(post.assetId).toBe(cut.id);
    expect(post.variantId).toBe(variant.id);
  });

  it("still refuses a variant that has nothing to do with the asset", async () => {
    const { cut } = await renderedCut();
    const stranger = await createAssetFixture({ projectId, uploaderId: userId, seed: 9 });
    const strangerVariant = await createVariantFixture({ assetId: stranger.id });

    await assessDistribution({
      assetId: cut.id,
      variantId: strangerVariant.id,
      platforms: [Platform.TIKTOK],
    });

    await expect(
      dispatchAutomated({
        assetId: cut.id,
        variantId: strangerVariant.id,
        platforms: [Platform.TIKTOK],
        userId,
      }),
    ).rejects.toThrow(/was not rendered from it/);
  });

  it("refuses a destination that has not been assessed", async () => {
    const { cut: asset, variant } = await renderedCut();

    const result = await dispatchAutomated({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
      userId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("has not been assessed");
  });

  it("refuses a cut the platform will not accept", async () => {
    const max = getAdapter(Platform.TIKTOK).constraints.maxDurationSeconds!;
    const { cut: asset, variant } = await renderedCut({ seconds: max + 120 });
    await assessDistribution({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
    });

    const result = await dispatchAutomated({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
      userId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("needs an optimised render");
    // Nothing was queued for publishing.
    expect(await prisma.post.count({ where: { projectId } })).toBe(0);
  });

  it("refuses a platform with no automated publish path", async () => {
    const { cut: asset, variant } = await renderedCut();
    await assessDistribution({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.YOUTUBE],
    });

    const youtube = getAdapter(Platform.YOUTUBE);
    if (youtube.capabilities.publish !== "UNSUPPORTED") return;

    const result = await dispatchAutomated({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.YOUTUBE],
      userId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("manual upload");
  });

  it("refuses a platform with no connected account", async () => {
    const { cut: asset, variant } = await renderedCut();
    await assessDistribution({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.INSTAGRAM],
    });

    const result = await dispatchAutomated({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.INSTAGRAM],
      userId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("No connected account");
  });
});

describe("the manual route", () => {
  it("hands over the file and the caption the automated path would have sent", async () => {
    const { cut: asset, variant } = await renderedCut();
    await prisma.contentVariant.update({
      where: { id: variant.id },
      data: {
        caption: "The body of the caption.",
        hashtags: ["#one"],
        cta: "Link in bio",
      },
    });
    const assessed = await assessDistribution({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.YOUTUBE],
    });
    const target = assessed.targets[0]!;

    const result = await exportForManualUpload({
      distributionId: target.distributionId,
      userId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.package.downloadUrl).toContain(asset.storageKey);
    // The exported caption is the composed one, not the raw variant text.
    expect(result.package.caption).toBe(target.caption);
    expect(result.package.steps.length).toBeGreaterThan(0);

    const row = await prisma.distribution.findUniqueOrThrow({
      where: { id: target.distributionId },
    });
    expect(row.status).toBe(DistributionStatus.EXPORTED);
    expect(row.route).toBe(DistributionRoute.MANUAL);
    expect(row.exportedById).toBe(userId);
    expect(row.exportedAt).not.toBeNull();
  });

  it("refuses to export a cut that needs optimising first", async () => {
    const max = getAdapter(Platform.TIKTOK).constraints.maxDurationSeconds!;
    const { cut: asset, variant } = await renderedCut({ seconds: max + 120 });
    const assessed = await assessDistribution({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
    });

    const result = await exportForManualUpload({
      distributionId: assessed.targets[0]!.distributionId,
      userId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("too long");
  });

  it("refuses to export a blocked cut rather than moving the rejection downstream", async () => {
    const { cut: asset, variant } = await renderedCut();
    await prisma.contentAsset.update({
      where: { id: asset.id },
      data: { mimeType: "video/x-msvideo" },
    });
    const assessed = await assessDistribution({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
    });
    expect(assessed.targets[0]!.fit).toBe(DistributionFit.BLOCKED);

    const result = await exportForManualUpload({
      distributionId: assessed.targets[0]!.distributionId,
      userId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cannot fix");
  });
});

describe("platform optimisation", () => {
  it("trims an EDL to a budget, dropping whole clips from the end", () => {
    const edl = {
      clips: [
        { assetId: "a", sourceStart: 0, sourceEnd: 10 },
        { assetId: "a", sourceStart: 10, sourceEnd: 20 },
        { assetId: "a", sourceStart: 20, sourceEnd: 30 },
      ],
    };
    const trimmed = trimEdlToBudget(edl, 15);
    expect(trimmed).not.toBeNull();
    expect(trimmed!.clips).toHaveLength(2);
    // The last surviving clip is shortened to land on the budget.
    expect(trimmed!.clips[1]!.sourceEnd).toBe(15);
  });

  it("keeps the opening intact when it trims", () => {
    const edl = {
      clips: [
        { assetId: "a", sourceStart: 0, sourceEnd: 4 },
        { assetId: "a", sourceStart: 4, sourceEnd: 40 },
      ],
    };
    const trimmed = trimEdlToBudget(edl, 10);
    expect(trimmed!.clips[0]).toEqual({ assetId: "a", sourceStart: 0, sourceEnd: 4 });
  });

  it("returns null rather than an empty cut", () => {
    const edl = { clips: [{ assetId: "a", sourceStart: 0, sourceEnd: 10 }] };
    expect(trimEdlToBudget(edl, 0.2)).toBeNull();
  });

  it("refuses to optimise a cut that already fits", async () => {
    const { cut: asset, variant } = await renderedCut();
    const assessed = await assessDistribution({
      assetId: asset.id,
      variantId: variant.id,
      platforms: [Platform.TIKTOK],
    });

    const result = await optimizeForPlatform({
      distributionId: assessed.targets[0]!.distributionId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("already fits");
  });
});
