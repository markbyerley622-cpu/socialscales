import { stat } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  AssetOrigin,
  RenderStage,
  RenderStatus,
} from "@/generated/prisma/enums";
import { absolutePath } from "@/server/storage";
import {
  assignClips,
  buildEdlForVariant,
  edlDurationSeconds,
  ffmpegProvider,
  renderIdempotencyKey,
  renderOutputKey,
  RenderError,
  runRenderJob,
  sanitizeLog,
  validateEdl,
  verifyOutputProbe,
  wrapText,
  type EditingProvider,
  type MediaProbe,
  type RenderEdl,
  type RenderSource,
} from "@/server/rendering";
import { attachAssetToBrief } from "@/server/content-director";
import {
  createAssetFixture,
  createOperator,
  createProjectFixture,
  createRealAssetFixture,
  ensureWorkspace,
  ffmpegAvailable,
  migrateTestSchema,
  resetDatabase,
} from "./helpers";

/**
 * Phase 7: rendering.
 *
 * The chain under test is raw assets -> treatment -> render job -> a real,
 * playable, vertical MP4. The rendering tests run real ffmpeg against real
 * generated media, because a renderer verified against a stub proves nothing
 * about whether it produces a file a platform will accept.
 *
 * Where ffmpeg is genuinely unavailable the encoding tests are skipped with a
 * message rather than passed quietly — a green run that never encoded anything
 * would be worse than a red one.
 */

const HAS_FFMPEG = ffmpegAvailable();
const encodes = HAS_FFMPEG ? describe : describe.skip;

let workspaceId: string;
let projectId: string;
let userId: string;

beforeAll(async () => {
  await migrateTestSchema();
  if (!HAS_FFMPEG) {
    console.warn(
      "[rendering] ffmpeg/ffprobe not found — the encoding tests are being SKIPPED, not passed.",
    );
  }
});

beforeEach(async () => {
  await resetDatabase();
  workspaceId = (await ensureWorkspace()).id;
  const project = await createProjectFixture({ workspaceId });
  projectId = project.id;
  userId = (await createOperator()).id;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Beat = {
  startSeconds: number;
  endSeconds: number;
  shot: string;
  onScreenText: string | null;
  voiceover: string | null;
};

const BEATS: Beat[] = [
  {
    startSeconds: 0,
    endSeconds: 2,
    shot: "Open on the subject, no title card.",
    onScreenText: "Stop scrolling",
    voiceover: "Stop scrolling.",
  },
  {
    startSeconds: 2,
    endSeconds: 5,
    shot: "Show the substance.",
    onScreenText: null,
    voiceover: "Here is the thing working.",
  },
  {
    startSeconds: 5,
    endSeconds: 7,
    shot: "Hold while the ask lands.",
    onScreenText: "Link in bio",
    voiceover: "Link in bio.",
  },
];

async function variantWithTreatment(
  assetId: string,
  overrides: { label?: string; beats?: Beat[] } = {},
) {
  return prisma.contentVariant.create({
    data: {
      assetId,
      label: overrides.label ?? "Cut",
      hook: "Stop scrolling: this is the test.",
      caption: "A caption long enough to be a caption.",
      cta: "Link in bio",
      hashtags: ["#testing"],
      hookFamily: "direct",
      narrativeStructure: "hook-substance-ask",
      ctaPlacement: "END",
      deliversKeyMessage: true,
      keyMessageNote: "Beat 2 carries it.",
      treatment: { beats: overrides.beats ?? BEATS },
    },
  });
}

function fakeProbe(over: Partial<MediaProbe> = {}): MediaProbe {
  return {
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    durationSeconds: 7,
    sizeBytes: 100_000,
    video: { codec: "h264", width: 1080, height: 1920, fps: 30 },
    audio: { codec: "aac", channels: 2, sampleRate: 48_000 },
    ...over,
  };
}

function edlOf(clips: RenderEdl["clips"]): RenderEdl {
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    clips,
    preserveSourceAudio: true,
    normalizeAudio: true,
    burnSubtitles: false,
    backgroundAudio: null,
  };
}

// ---------------------------------------------------------------------------
// The EDL
// ---------------------------------------------------------------------------

describe("building an edit decision list", () => {
  it("refuses to cut a variant that has no treatment", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 1 });
    const variant = await prisma.contentVariant.create({
      data: {
        assetId: asset.id,
        label: "Bare",
        hook: "A hook.",
        caption: "A caption.",
        cta: "Link in bio",
      },
    });

    await expect(buildEdlForVariant(variant.id)).rejects.toMatchObject({
      kind: "INVALID_TIMING",
    });
  });

  it("maps each beat onto a source range and keeps the treatment's shape", async () => {
    const asset = await createAssetFixture({
      projectId,
      uploaderId: userId,
      seed: 2,
      durationSeconds: 30,
    });
    const variant = await variantWithTreatment(asset.id);

    const built = await buildEdlForVariant(variant.id);
    expect(built.edl.clips).toHaveLength(3);
    expect(built.edl.width).toBe(1080);
    expect(built.edl.height).toBe(1920);
    // The cut is as long as the treatment asked for.
    expect(edlDurationSeconds(built.edl)).toBeCloseTo(7, 1);
    // The beats' text carries through to the clips.
    expect(built.edl.clips[0]?.onScreenText).toBe("Stop scrolling");
    expect(built.edl.clips[1]?.onScreenText).toBeNull();
    expect(built.edl.clips[0]?.subtitle).toBe("Stop scrolling.");
  });

  it("spreads clips across every source made for the same brief", () => {
    const sources: RenderSource[] = [
      { assetId: "a", absolutePath: "/a.mp4", durationSeconds: 30, mimeType: "video/mp4", kind: "VIDEO" },
      { assetId: "b", absolutePath: "/b.mp4", durationSeconds: 30, mimeType: "video/mp4", kind: "VIDEO" },
    ];
    const clips = assignClips(BEATS, sources);
    expect(clips.map((clip) => clip.assetId)).toEqual(["a", "b", "a"]);
    // Each source is consumed forward rather than restarting every time.
    expect(clips[2]?.sourceStart).toBeGreaterThan(0);
  });

  it("consumes a single source forward rather than repeating its opening", () => {
    const sources: RenderSource[] = [
      { assetId: "a", absolutePath: "/a.mp4", durationSeconds: 30, mimeType: "video/mp4", kind: "VIDEO" },
    ];
    const clips = assignClips(BEATS, sources);
    expect(clips.map((clip) => clip.sourceStart)).toEqual([0, 2, 5]);
    expect(clips[2]?.sourceEnd).toBe(7);
  });

  it("never asks for more footage than a short source contains", () => {
    const sources: RenderSource[] = [
      { assetId: "a", absolutePath: "/a.mp4", durationSeconds: 3, mimeType: "video/mp4", kind: "VIDEO" },
    ];
    const clips = assignClips(BEATS, sources);
    for (const clip of clips) {
      expect(clip.sourceEnd).toBeLessThanOrEqual(3);
      expect(clip.sourceEnd).toBeGreaterThan(clip.sourceStart);
    }
  });

  it("refuses a still image, explicitly", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 3 });
    await prisma.contentAsset.update({
      where: { id: asset.id },
      data: { kind: "IMAGE" },
    });
    const variant = await variantWithTreatment(asset.id);

    await expect(buildEdlForVariant(variant.id)).rejects.toMatchObject({
      kind: "UNSUPPORTED_SOURCE",
    });
  });
});

describe("validating before rendering", () => {
  const source: RenderSource = {
    assetId: "a",
    absolutePath: "/nowhere/a.mp4",
    durationSeconds: 10,
    mimeType: "video/mp4",
    kind: "VIDEO",
  };

  it("rejects a clip that runs past the end of its source", async () => {
    const edl = edlOf([
      { assetId: "a", sourceStart: 8, sourceEnd: 14, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    await expect(validateEdl(edl, [source])).rejects.toMatchObject({
      kind: "INVALID_TIMING",
    });
  });

  it("rejects a clip that ends before it starts", async () => {
    const edl = edlOf([
      { assetId: "a", sourceStart: 5, sourceEnd: 5, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    await expect(validateEdl(edl, [source])).rejects.toMatchObject({
      kind: "INVALID_TIMING",
    });
  });

  it("rejects a clip referencing an asset the job does not carry", async () => {
    const edl = edlOf([
      { assetId: "ghost", sourceStart: 0, sourceEnd: 2, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    await expect(validateEdl(edl, [source])).rejects.toMatchObject({
      kind: "MISSING_ASSET",
    });
  });

  it("rejects a source whose file has gone missing from storage", async () => {
    const edl = edlOf([
      { assetId: "a", sourceStart: 0, sourceEnd: 2, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    await expect(validateEdl(edl, [source])).rejects.toMatchObject({
      kind: "MISSING_ASSET",
    });
  });
});

// ---------------------------------------------------------------------------
// Output verification
// ---------------------------------------------------------------------------

describe("verifying what was produced", () => {
  const edl = edlOf([
    { assetId: "a", sourceStart: 0, sourceEnd: 7, onScreenText: null, subtitle: null, muteAudio: false },
  ]);

  it("accepts a real vertical H.264 MP4", () => {
    expect(() => verifyOutputProbe(fakeProbe(), edl)).not.toThrow();
  });

  it("rejects an empty file", () => {
    expect(() => verifyOutputProbe(fakeProbe({ sizeBytes: 0 }), edl)).toThrow(/empty/i);
  });

  it("rejects a file with no video stream", () => {
    expect(() => verifyOutputProbe(fakeProbe({ video: null }), edl)).toThrow(
      /no video stream/i,
    );
  });

  it("rejects the wrong dimensions", () => {
    const probe = fakeProbe({
      video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
    });
    expect(() => verifyOutputProbe(probe, edl)).toThrow(/1920×1080/);
  });

  it("rejects a codec the platforms will not take", () => {
    const probe = fakeProbe({
      video: { codec: "vp9", width: 1080, height: 1920, fps: 30 },
    });
    expect(() => verifyOutputProbe(probe, edl)).toThrow(/H.264/);
  });

  it("rejects a zero-length file", () => {
    expect(() => verifyOutputProbe(fakeProbe({ durationSeconds: 0 }), edl)).toThrow(
      /no duration/i,
    );
  });

  it("rejects a cut that lost most of its clips", () => {
    // ffmpeg exits zero, the file is a valid MP4, and it is a third as long as
    // the treatment asked for. That is a silent failure, not a success.
    expect(() => verifyOutputProbe(fakeProbe({ durationSeconds: 2 }), edl)).toThrow(
      /Clips were dropped/,
    );
  });
});

// ---------------------------------------------------------------------------
// Log hygiene
// ---------------------------------------------------------------------------

describe("log sanitisation", () => {
  it("strips the storage root out of ffmpeg output", () => {
    const key = renderOutputKey("proj", "abc");
    const raw = `Output #0, mp4, to '${absolutePath(key)}':`;
    const clean = sanitizeLog(raw);
    expect(clean).not.toContain(absolutePath(key));
    expect(clean).toContain("<storage>");
  });

  it("strips absolute paths it does not recognise", () => {
    const clean = sanitizeLog("Input #0 from 'C:\\Users\\someone\\Videos\\private.mp4'");
    expect(clean).not.toContain("someone");
    expect(clean).toContain("private.mp4");
  });
});

// ---------------------------------------------------------------------------
// Idempotency and lifecycle, without encoding
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("gives the same request the same key and the same output path", async () => {
    const asset = await createAssetFixture({
      projectId,
      uploaderId: userId,
      seed: 4,
      durationSeconds: 30,
    });
    const variant = await variantWithTreatment(asset.id);

    const first = await buildEdlForVariant(variant.id);
    const second = await buildEdlForVariant(variant.id);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(renderOutputKey(projectId, first.idempotencyKey)).toBe(
      renderOutputKey(projectId, second.idempotencyKey),
    );
  });

  it("gives a different cut a different key", () => {
    const a = edlOf([
      { assetId: "a", sourceStart: 0, sourceEnd: 5, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    const b = edlOf([
      { assetId: "a", sourceStart: 0, sourceEnd: 6, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    expect(renderIdempotencyKey("v1", a)).not.toBe(renderIdempotencyKey("v1", b));
  });

  it("returns the finished output instead of rendering a second time", async () => {
    const asset = await createAssetFixture({
      projectId,
      uploaderId: userId,
      seed: 5,
      durationSeconds: 30,
    });
    const variant = await variantWithTreatment(asset.id);
    const built = await buildEdlForVariant(variant.id);

    const output = await createAssetFixture({ projectId, uploaderId: userId, seed: 6 });
    const job = await prisma.renderJob.create({
      data: {
        projectId,
        variantId: variant.id,
        idempotencyKey: built.idempotencyKey,
        status: RenderStatus.SUCCEEDED,
        stage: RenderStage.DONE,
        config: built.edl as never,
        sourceAssetIds: built.sources.map((source) => source.assetId),
        outputAssetId: output.id,
        outputKey: renderOutputKey(projectId, built.idempotencyKey),
      },
    });

    let rendered = false;
    const provider = stubProvider(() => {
      rendered = true;
    });
    const result = await runRenderJob(job.id, { provider });

    expect(result.outcome).toBe("skipped");
    expect(result.outputAssetId).toBe(output.id);
    expect(rendered).toBe(false);
  });
});

describe("failure handling", () => {
  async function jobFor(edl: RenderEdl, sourceIds: string[]) {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 20 });
    const variant = await variantWithTreatment(asset.id);
    return prisma.renderJob.create({
      data: {
        projectId,
        variantId: variant.id,
        idempotencyKey: `test-${Math.random().toString(36).slice(2)}`,
        config: edl as never,
        sourceAssetIds: sourceIds,
      },
    });
  }

  it("records the stage and reason when ffmpeg is unavailable, and does not retry", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 21 });
    const edl = edlOf([
      { assetId: asset.id, sourceStart: 0, sourceEnd: 2, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    const job = await jobFor(edl, [asset.id]);

    const provider = stubProvider(() => {}, {
      availability: async () => ({ available: false, reason: "ffmpeg was not found on PATH." }),
    });
    const result = await runRenderJob(job.id, { provider });

    expect(result.outcome).toBe("failed");
    expect(result.errorKind).toBe("FFMPEG_UNAVAILABLE");
    // Retrying will not conjure an ffmpeg binary.
    expect(result.retryable).toBe(false);

    const row = await prisma.renderJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe(RenderStatus.FAILED);
    expect(row.failureStage).toBe(RenderStage.VALIDATING);
    expect(row.error).toContain("not found on PATH");
  });

  it("fails explicitly when a source was deleted after queueing", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 22 });
    const edl = edlOf([
      { assetId: asset.id, sourceStart: 0, sourceEnd: 2, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    const job = await jobFor(edl, [asset.id]);
    await prisma.contentAsset.delete({ where: { id: asset.id } });

    const result = await runRenderJob(job.id, { provider: stubProvider(() => {}) });
    expect(result.outcome).toBe("failed");
    expect(result.errorKind).toBe("MISSING_ASSET");
    expect(result.retryable).toBe(false);
  });

  it("fails explicitly on an out-of-range trim", async () => {
    const asset = await createAssetFixture({
      projectId,
      uploaderId: userId,
      seed: 23,
      durationSeconds: 5,
    });
    const edl = edlOf([
      { assetId: asset.id, sourceStart: 0, sourceEnd: 60, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    const job = await jobFor(edl, [asset.id]);

    const result = await runRenderJob(job.id, { provider: stubProvider(() => {}) });
    expect(result.errorKind).toBe("INVALID_TIMING");
    expect(result.retryable).toBe(false);
  });

  it("keeps an ffmpeg crash retryable and stores a sanitised log", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 24 });
    const edl = edlOf([
      { assetId: asset.id, sourceStart: 0, sourceEnd: 2, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    const job = await jobFor(edl, [asset.id]);

    const provider = stubProvider(() => {
      throw new RenderError("FFMPEG_FAILED", RenderStage.ENCODING, "ffmpeg exited with code 1.", {
        log: "Error while filtering: Invalid argument",
      });
    });
    const result = await runRenderJob(job.id, { provider });

    expect(result.outcome).toBe("failed");
    expect(result.errorKind).toBe("FFMPEG_FAILED");
    expect(result.retryable).toBe(true);

    const row = await prisma.renderJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.failureStage).toBe(RenderStage.ENCODING);
    expect(row.logExcerpt).toContain("Invalid argument");
  });

  it("rejects a produced file that is not what was asked for", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 25 });
    const edl = edlOf([
      { assetId: asset.id, sourceStart: 0, sourceEnd: 2, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    const job = await jobFor(edl, [asset.id]);

    // Claims success, hands back a landscape file.
    const provider = stubProvider(() => {}, {
      probeResult: fakeProbe({
        video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
      }),
    });
    const result = await runRenderJob(job.id, { provider });

    expect(result.outcome).toBe("failed");
    expect(result.errorKind).toBe("OUTPUT_INVALID");

    const row = await prisma.renderJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.failureStage).toBe(RenderStage.PROBING);
    // Nothing was registered as a finished cut.
    expect(row.outputAssetId).toBeNull();
    expect(
      await prisma.contentAsset.count({ where: { projectId, origin: AssetOrigin.RENDER } }),
    ).toBe(0);
  });

  it("increments attempts on every run so a loop is visible", async () => {
    const asset = await createAssetFixture({ projectId, uploaderId: userId, seed: 26 });
    const edl = edlOf([
      { assetId: asset.id, sourceStart: 0, sourceEnd: 2, onScreenText: null, subtitle: null, muteAudio: false },
    ]);
    const job = await jobFor(edl, [asset.id]);
    const provider = stubProvider(() => {
      throw new RenderError("FFMPEG_FAILED", RenderStage.ENCODING, "boom");
    });

    await runRenderJob(job.id, { provider });
    await runRenderJob(job.id, { provider });

    const row = await prisma.renderJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.attempts).toBe(2);
  });
});

describe("text layout", () => {
  it("wraps on word boundaries rather than mid-word", () => {
    const wrapped = wrapText("Stop scrolling: this is the smoke test", 20);
    expect(wrapped.split("\n").every((line) => line.length <= 20)).toBe(true);
    expect(wrapped.replace(/\n/g, " ")).toBe("Stop scrolling: this is the smoke test");
  });
});

// ---------------------------------------------------------------------------
// Real encoding
// ---------------------------------------------------------------------------

encodes("rendering real media", () => {
  it("reports that ffmpeg is available and gives its version", async () => {
    const availability = await ffmpegProvider.availability();
    expect(availability.available).toBe(true);
    if (availability.available) expect(availability.version).toMatch(/\d/);
  });

  it(
    "turns raw assets and a treatment into a playable vertical MP4",
    async () => {
      const asset = await createRealAssetFixture({
        projectId,
        uploaderId: userId,
        seconds: 8,
        width: 640,
        height: 360,
      });
      const variant = await variantWithTreatment(asset.id);
      const built = await buildEdlForVariant(variant.id);

      const job = await prisma.renderJob.create({
        data: {
          projectId,
          variantId: variant.id,
          idempotencyKey: built.idempotencyKey,
          config: built.edl as never,
          sourceAssetIds: built.sources.map((source) => source.assetId),
        },
      });

      const result = await runRenderJob(job.id);
      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") return;

      // The file exists on disk, at the deterministic key.
      expect(result.outputKey).toBe(renderOutputKey(projectId, built.idempotencyKey));
      const info = await stat(absolutePath(result.outputKey!));
      expect(info.size).toBeGreaterThan(0);

      // And it is genuinely playable, probed independently of the renderer.
      const probe = await ffmpegProvider.probe(absolutePath(result.outputKey!));
      expect(probe.video?.width).toBe(1080);
      expect(probe.video?.height).toBe(1920);
      expect(probe.video?.codec).toMatch(/h264/);
      expect(probe.audio?.codec).toMatch(/aac/);
      expect(probe.durationSeconds).toBeGreaterThan(6);
      expect(probe.formatName).toContain("mp4");

      // It is registered as an ordinary asset, so publishing needs no new path.
      const output = await prisma.contentAsset.findUniqueOrThrow({
        where: { id: result.outputAssetId! },
      });
      expect(output.origin).toBe(AssetOrigin.RENDER);
      expect(output.width).toBe(1080);
      expect(output.height).toBe(1920);
      expect(output.aspectRatio).toBe("9:16");
      expect(output.hasAudio).toBe(true);
      expect(output.mimeType).toBe("video/mp4");

      const row = await prisma.renderJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(row.status).toBe(RenderStatus.SUCCEEDED);
      expect(row.stage).toBe(RenderStage.DONE);
      expect(row.progress).toBe(100);
      expect(row.durationMs).toBeGreaterThan(0);
      expect(row.startedAt).not.toBeNull();
      expect(row.completedAt).not.toBeNull();
      expect(row.outputProbe).not.toBeNull();
    },
    240_000,
  );

  it(
    "does not produce a second output when the same request is retried",
    async () => {
      const asset = await createRealAssetFixture({
        projectId,
        uploaderId: userId,
        seconds: 8,
      });
      const variant = await variantWithTreatment(asset.id);
      const built = await buildEdlForVariant(variant.id);

      const job = await prisma.renderJob.create({
        data: {
          projectId,
          variantId: variant.id,
          idempotencyKey: built.idempotencyKey,
          config: built.edl as never,
          sourceAssetIds: built.sources.map((source) => source.assetId),
        },
      });

      const first = await runRenderJob(job.id);
      expect(first.outcome).toBe("succeeded");

      // Simulate a worker killed after the encode but before the row was
      // finalised: the status goes back to RUNNING and the job is run again.
      await prisma.renderJob.update({
        where: { id: job.id },
        data: {
          status: RenderStatus.RUNNING,
          outputAssetId: null,
          progress: 40,
        },
      });

      const second = await runRenderJob(job.id);
      expect(second.outcome).toBe("succeeded");
      expect(second.outputKey).toBe(first.outputKey);

      // One file, one asset. The second run adopted the first's output.
      const outputs = await prisma.contentAsset.findMany({
        where: { projectId, origin: AssetOrigin.RENDER },
      });
      expect(outputs).toHaveLength(1);
      expect(second.outputAssetId).toBe(outputs[0]!.id);
    },
    240_000,
  );

  it(
    "renders three treatments into three finished cuts",
    async () => {
      const asset = await createRealAssetFixture({
        projectId,
        uploaderId: userId,
        seconds: 8,
      });

      const variants = await Promise.all([
        variantWithTreatment(asset.id, { label: "Problem first" }),
        variantWithTreatment(asset.id, {
          label: "POV",
          beats: BEATS.map((beat) => ({ ...beat, onScreenText: "POV: it works" })),
        }),
        variantWithTreatment(asset.id, {
          label: "Numeric",
          beats: BEATS.map((beat) => ({ ...beat, endSeconds: beat.endSeconds + 0.5 })),
        }),
      ]);

      const results = [];
      for (const variant of variants) {
        const built = await buildEdlForVariant(variant.id);
        const job = await prisma.renderJob.create({
          data: {
            projectId,
            variantId: variant.id,
            idempotencyKey: built.idempotencyKey,
            config: built.edl as never,
            sourceAssetIds: built.sources.map((source) => source.assetId),
          },
        });
        results.push(await runRenderJob(job.id));
      }

      expect(results.every((result) => result.outcome === "succeeded")).toBe(true);

      const outputs = await prisma.contentAsset.findMany({
        where: { projectId, origin: AssetOrigin.RENDER },
      });
      expect(outputs).toHaveLength(3);
      // Three distinct files, not one reused three times.
      expect(new Set(outputs.map((output) => output.storageKey)).size).toBe(3);
      for (const output of outputs) {
        const probe = await ffmpegProvider.probe(absolutePath(output.storageKey));
        expect(probe.video?.height).toBe(1920);
        expect(probe.durationSeconds).toBeGreaterThan(0);
      }
    },
    600_000,
  );

  it(
    "letterboxes a landscape source instead of cropping the subject away",
    async () => {
      const asset = await createRealAssetFixture({
        projectId,
        uploaderId: userId,
        seconds: 6,
        width: 1280,
        height: 720,
      });
      const variant = await variantWithTreatment(asset.id, {
        beats: [
          {
            startSeconds: 0,
            endSeconds: 3,
            shot: "Wide landscape shot.",
            onScreenText: null,
            voiceover: null,
          },
        ],
      });
      const built = await buildEdlForVariant(variant.id);
      const job = await prisma.renderJob.create({
        data: {
          projectId,
          variantId: variant.id,
          idempotencyKey: built.idempotencyKey,
          config: built.edl as never,
          sourceAssetIds: built.sources.map((source) => source.assetId),
        },
      });

      const result = await runRenderJob(job.id);
      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") return;

      const probe = await ffmpegProvider.probe(absolutePath(result.outputKey!));
      expect(probe.video?.width).toBe(1080);
      expect(probe.video?.height).toBe(1920);
    },
    240_000,
  );

  it(
    "gives a silent source a real audio track rather than a missing one",
    async () => {
      const asset = await createRealAssetFixture({
        projectId,
        uploaderId: userId,
        seconds: 6,
        silent: true,
      });
      const variant = await variantWithTreatment(asset.id, {
        beats: [
          {
            startSeconds: 0,
            endSeconds: 4,
            shot: "Silent footage.",
            onScreenText: null,
            voiceover: null,
          },
        ],
      });
      const built = await buildEdlForVariant(variant.id);
      const job = await prisma.renderJob.create({
        data: {
          projectId,
          variantId: variant.id,
          idempotencyKey: built.idempotencyKey,
          config: built.edl as never,
          sourceAssetIds: built.sources.map((source) => source.assetId),
        },
      });

      const result = await runRenderJob(job.id);
      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") return;

      const probe = await ffmpegProvider.probe(absolutePath(result.outputKey!));
      // A missing audio track breaks some uploaders; generated silence does not.
      expect(probe.audio).not.toBeNull();
      expect(probe.audio?.codec).toMatch(/aac/);
    },
    240_000,
  );

  it(
    "cuts across two sources attached to the same brief",
    async () => {
      const { createContentPlan } = await import("@/server/content-director");
      const { generateStrategy } = await import("@/server/strategy");
      const { ingestAllKnowledge } = await import("@/server/knowledge");

      await ingestAllKnowledge({ workspaceId, projectId: null });
      await prisma.businessObjective.create({
        data: { projectId, kind: "PROFILE_VISITS", kpi: "profileVisits", priority: 1 },
      });
      const strategy = await generateStrategy({ workspaceId, projectId, activate: true });
      expect(strategy.ok).toBe(true);
      const plan = await createContentPlan({
        workspaceId,
        projectId,
        days: 7,
        activate: true,
      });
      expect(plan.ok).toBe(true);

      const brief = await prisma.contentBrief.findFirstOrThrow({
        where: { projectId },
        orderBy: { sequence: "asc" },
      });

      const first = await createRealAssetFixture({
        projectId,
        uploaderId: userId,
        seconds: 6,
        hz: 440,
      });
      const second = await createRealAssetFixture({
        projectId,
        uploaderId: userId,
        seconds: 6,
        hz: 660,
      });
      await attachAssetToBrief({ assetId: first.id, briefId: brief.id });
      await attachAssetToBrief({ assetId: second.id, briefId: brief.id });

      const variant = await variantWithTreatment(first.id);
      const built = await buildEdlForVariant(variant.id);

      // Both sources are in play, and the cut alternates between them.
      expect(built.sources.length).toBe(2);
      expect(new Set(built.edl.clips.map((clip) => clip.assetId)).size).toBe(2);

      const job = await prisma.renderJob.create({
        data: {
          projectId,
          variantId: variant.id,
          idempotencyKey: built.idempotencyKey,
          config: built.edl as never,
          sourceAssetIds: built.sources.map((source) => source.assetId),
        },
      });
      const result = await runRenderJob(job.id);
      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") return;

      const probe = await ffmpegProvider.probe(absolutePath(result.outputKey!));
      expect(probe.video?.height).toBe(1920);
      expect(probe.durationSeconds).toBeGreaterThan(5);
    },
    600_000,
  );
});

// ---------------------------------------------------------------------------
// A provider that does not encode, for the lifecycle tests
// ---------------------------------------------------------------------------

function stubProvider(
  onRender: () => void,
  options: {
    availability?: EditingProvider["availability"];
    probeResult?: MediaProbe;
  } = {},
): EditingProvider {
  return {
    name: "stub-editor",
    kind: "STUB",
    availability:
      options.availability ??
      (async () => ({ available: true, version: "stub" })),
    textSupport: async () => ({ supported: true }),
    async render(request) {
      onRender();
      // Write something, so the runner's move and probe steps are real.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(request.outputPath, Buffer.alloc(1_024, 1));
      return {
        outputPath: request.outputPath,
        probe: options.probeResult ?? fakeProbe(),
        log: "stub render",
        durationMs: 1,
      };
    },
    async probe() {
      return options.probeResult ?? fakeProbe();
    },
  };
}
