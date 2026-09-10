import { describe, expect, it } from "vitest";
import { probeMedia, ratio } from "@/server/media/probe";
import {
  MediaValidationError,
  sniffMediaType,
  validateUpload,
} from "@/server/media/validate";
import {
  hashPassword,
  seal,
  sealJson,
  unseal,
  unsealJson,
  verifyPassword,
} from "@/server/security/crypto";
import { heuristicProvider } from "@/server/ai/heuristic-provider";
import { getAdapter, listAdapters } from "@/server/platforms/registry";
import { composeStandardCaption } from "@/server/platforms/types";
import { decideApproval, averageScore } from "@/server/services/post-service";
import { idempotencyKeyFor } from "@/server/services/publish-service";
import { queueJobId } from "@/server/jobs/queues";
import { dueWindows } from "@/server/analytics/snapshots";
import { median, dailySeries, recentMomentum } from "@/server/analytics/aggregate";
import {
  assignConfidence,
  classifyCta,
  classifyHook,
  classifyHour,
  classifyLength,
  MIN_DATASET,
} from "@/server/learning/engine";
import { buildSampleMp4, buildSamplePng, hexToRgb } from "../prisma/sample-media";
import {
  AssetKind,
  Confidence,
  Platform,
  PublishPolicy,
} from "@/generated/prisma/enums";

/**
 * Pure-logic tests. No database, no network, no browser — these cover the
 * decisions the rest of the system trusts.
 */

describe("media validation", () => {
  it("identifies supported types from their magic bytes, not their extension", () => {
    const mp4 = buildSampleMp4({
      durationSeconds: 10,
      width: 1080,
      height: 1920,
      hasAudio: true,
      payloadBytes: 128,
    });
    const png = buildSamplePng({ width: 8, height: 8, color: [1, 2, 3] });

    expect(sniffMediaType(mp4.subarray(0, 32))?.mimeType).toBe("video/mp4");
    expect(sniffMediaType(png.subarray(0, 32))?.mimeType).toBe("image/png");
  });

  it("rejects a file that only claims to be a video", () => {
    const notAVideo = Buffer.from("This is plain text pretending to be an mp4.");
    expect(() =>
      validateUpload({
        head: notAVideo.subarray(0, 32),
        sizeBytes: notAVideo.byteLength,
        declaredMime: "video/mp4",
        filename: "evil.mp4",
      }),
    ).toThrow(MediaValidationError);
  });

  it("rejects an empty file", () => {
    const mp4 = buildSampleMp4({
      durationSeconds: 1,
      width: 100,
      height: 100,
      hasAudio: false,
      payloadBytes: 16,
    });
    expect(() =>
      validateUpload({
        head: mp4.subarray(0, 32),
        sizeBytes: 0,
        filename: "empty.mp4",
      }),
    ).toThrow(/empty/i);
  });

  it("enforces the size ceiling for the sniffed type", () => {
    const png = buildSamplePng({ width: 8, height: 8, color: [9, 9, 9] });
    expect(() =>
      validateUpload({
        head: png.subarray(0, 32),
        sizeBytes: 64 * 1024 * 1024,
        filename: "huge.png",
      }),
    ).toThrow(/over the 32 MB limit/);
  });
});

describe("container probe", () => {
  it("reads duration, dimensions and the audio flag out of the bytes", () => {
    const buffer = buildSampleMp4({
      durationSeconds: 27.5,
      width: 1080,
      height: 1920,
      hasAudio: true,
      payloadBytes: 512,
    });
    const probe = probeMedia(buffer, AssetKind.VIDEO);

    expect(probe.durationSeconds).toBeCloseTo(27.5, 1);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.aspectRatio).toBe("9:16");
    expect(probe.hasAudio).toBe(true);
  });

  it("reports a missing audio track rather than guessing", () => {
    const buffer = buildSampleMp4({
      durationSeconds: 12,
      width: 1920,
      height: 1080,
      hasAudio: false,
      payloadBytes: 256,
    });
    const probe = probeMedia(buffer, AssetKind.VIDEO);

    expect(probe.hasAudio).toBe(false);
    expect(probe.aspectRatio).toBe("16:9");
  });

  it("reads PNG dimensions", () => {
    const buffer = buildSamplePng({
      width: 1080,
      height: 1350,
      color: hexToRgb("#9085e9"),
    });
    const probe = probeMedia(buffer, AssetKind.IMAGE);

    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1350);
    expect(probe.aspectRatio).toBe("4:5");
    // An image has no duration, and the probe must say so rather than return 0.
    expect(probe.durationSeconds).toBeNull();
  });

  it("returns nulls instead of throwing on a corrupt container", () => {
    const junk = Buffer.alloc(400, 7);
    expect(probeMedia(junk, AssetKind.VIDEO)).toEqual({
      durationSeconds: null,
      width: null,
      height: null,
      aspectRatio: null,
      hasAudio: null,
    });
  });

  it("labels familiar ratios and reduces unfamiliar ones", () => {
    expect(ratio(1080, 1920)).toBe("9:16");
    expect(ratio(1000, 1000)).toBe("1:1");
    expect(ratio(1000, 300)).toBe("10:3");
    expect(ratio(null, 100)).toBeNull();
  });
});

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");

    expect(stored.startsWith("scrypt$")).toBe(true);
    // The plaintext must not be recoverable from the stored value.
    expect(stored).not.toContain("correct horse");
    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", stored)).resolves.toBe(false);
  });

  it("salts, so the same password hashes differently each time", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("rejects a malformed stored hash instead of throwing", async () => {
    await expect(verifyPassword("anything", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("anything", "scrypt$a$b$c$d$e")).resolves.toBe(false);
  });
});

describe("session encryption", () => {
  it("round-trips a storage state", () => {
    const state = { cookies: [{ name: "sid", value: "abc" }], origins: [] };
    const sealed = sealJson(state);

    expect(sealed.algorithm).toBe("aes-256-gcm");
    expect(sealed.cipherText).not.toContain("abc");
    expect(unsealJson(sealed)).toEqual(state);
  });

  it("refuses to decrypt tampered ciphertext", () => {
    const sealed = seal("sensitive session blob");
    const tampered = Buffer.from(sealed.cipherText, "base64");
    tampered[0] ^= 0xff;

    expect(() =>
      unseal({ ...sealed, cipherText: tampered.toString("base64") }),
    ).toThrow();
  });

  it("refuses to decrypt with a tampered auth tag", () => {
    const sealed = seal("sensitive session blob");
    const tag = Buffer.from(sealed.authTag, "base64");
    tag[0] ^= 0xff;

    expect(() => unseal({ ...sealed, authTag: tag.toString("base64") })).toThrow();
  });
});

describe("platform adapters", () => {
  it("declares a capability for every operation", () => {
    for (const adapter of listAdapters()) {
      for (const capability of [
        "upload",
        "publish",
        "nativeSchedule",
        "metrics",
        "checkStatus",
      ] as const) {
        expect(["OFFICIAL_API", "BROWSER_ASSISTED", "UNSUPPORTED"]).toContain(
          adapter.capabilities[capability],
        );
      }
    }
  });

  it("rejects a video that is too long for the platform", () => {
    const verdict = getAdapter(Platform.INSTAGRAM).validateMedia({
      mimeType: "video/mp4",
      sizeBytes: 5_000_000,
      durationSeconds: 240,
      aspectRatio: "9:16",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((issue) => issue.severity === "error")).toBe(true);
  });

  it("warns rather than blocks on a non-preferred aspect ratio", () => {
    const verdict = getAdapter(Platform.TIKTOK).validateMedia({
      mimeType: "video/mp4",
      sizeBytes: 5_000_000,
      durationSeconds: 24,
      aspectRatio: "16:9",
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.issues.map((issue) => issue.severity)).toContain("warning");
  });

  it("rejects an unsupported mime type", () => {
    const verdict = getAdapter(Platform.YOUTUBE).validateMedia({
      mimeType: "image/png",
      sizeBytes: 1_000,
      durationSeconds: null,
      aspectRatio: "9:16",
    });
    expect(verdict.ok).toBe(false);
  });

  it("caps hashtags at the platform limit and keeps the CTA", () => {
    const composed = composeStandardCaption(
      {
        caption: "Body copy.",
        cta: "Join the beta",
        hashtags: Array.from({ length: 20 }, (_, index) => `#tag${index}`),
      },
      getAdapter(Platform.TIKTOK).constraints,
    );

    const tagCount = (composed.match(/#tag/g) ?? []).length;
    expect(tagCount).toBe(getAdapter(Platform.TIKTOK).constraints.hashtagMaxCount);
    expect(composed).toContain("Join the beta");
  });

  it("never exceeds the caption length limit", () => {
    const constraints = getAdapter(Platform.TIKTOK).constraints;
    const composed = composeStandardCaption(
      {
        caption: "x".repeat(constraints.captionMaxLength + 500),
        cta: "Join the beta",
        hashtags: ["#one", "#two"],
      },
      constraints,
    );

    expect(composed.length).toBeLessThanOrEqual(constraints.captionMaxLength);
    expect(composed).toContain("Join the beta");
  });
});

describe("heuristic AI provider", () => {
  const brand = {
    projectName: "Creator AI",
    audience: "creators and solo agency owners",
    tone: "sharp",
    valueProp: "It plans a month of content in an afternoon.",
    primaryCta: "Join the beta — link in bio",
    website: null,
    bannedPhrases: ["game-changer"],
    pillars: ["Agency replacement"],
    knownHashtags: ["#smma", "#creatoreconomy"],
  };

  const asset = {
    title: "Agency teardown",
    originalFilename: "creator-agency-teardown-screen.mp4",
    kind: "VIDEO" as const,
    durationSeconds: 24,
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
    hasAudio: true,
    pillar: "Agency replacement",
  };

  it("detects format from filename signals", async () => {
    const analysis = await heuristicProvider.analyzeAsset({ asset, brand });
    expect(analysis.format).toBe("SCREEN_RECORDING");
  });

  it("declares that it cannot transcribe rather than inventing a transcript", async () => {
    const analysis = await heuristicProvider.analyzeAsset({ asset, brand });
    expect(heuristicProvider.canTranscribe).toBe(false);
    expect(analysis.transcript).toBeNull();
    expect(String(analysis.raw.limitations)).toMatch(/transcri/i);
  });

  it("produces distinct suggestions that keep a small hashtag set", async () => {
    const analysis = await heuristicProvider.analyzeAsset({ asset, brand });
    const suggestions = await heuristicProvider.suggestCopy({
      asset,
      brand,
      analysis,
      count: 3,
    });

    expect(suggestions).toHaveLength(3);
    expect(new Set(suggestions.map((s) => s.hook)).size).toBe(3);
    for (const suggestion of suggestions) {
      expect(suggestion.hashtags.length).toBeLessThanOrEqual(6);
      expect(suggestion.cta).toBe(brand.primaryCta);
    }
  });

  it("strips the project's banned phrases", async () => {
    const analysis = await heuristicProvider.analyzeAsset({ asset, brand });
    const suggestions = await heuristicProvider.suggestCopy({
      asset,
      brand: { ...brand, bannedPhrases: ["content"] },
      analysis,
      count: 5,
    });
    for (const suggestion of suggestions) {
      expect(suggestion.caption.toLowerCase()).not.toContain("content");
    }
  });

  it("penalises a missing CTA and a hashtag wall", () => {
    const scored = heuristicProvider.scoreCopy({
      suggestion: {
        label: "bad",
        hook: "A hook that goes on and on and on and never really gets to the point at all",
        caption: "Maybe this might possibly work, sort of.",
        hashtags: Array.from({ length: 14 }, (_, i) => `#x${i}`),
        cta: "",
      },
      brand,
      analysis: {
        format: "UNKNOWN",
        topic: null,
        likelyAudience: null,
        visualSummary: null,
        transcript: null,
        raw: {},
      },
    });

    expect(scored.cta).toBeLessThan(5);
    expect(scored.notes.join(" ")).toMatch(/No CTA/);
    expect(scored.notes.join(" ")).toMatch(/spam/);
  });
});

describe("approval policy", () => {
  const goodScorecard = {
    hook: 9,
    clarity: 9,
    curiosity: 8.5,
    cta: 9,
    trendRelevance: 9,
    notes: [],
  };

  it("always requires a human under manual approval", () => {
    const decision = decideApproval({
      policy: PublishPolicy.MANUAL_APPROVAL,
      scorecard: goodScorecard,
      issues: [],
    });
    expect(decision.autoApproved).toBe(false);
    expect(decision.approvalState).toBe("PENDING");
  });

  it("skips review under auto publish", () => {
    const decision = decideApproval({
      policy: PublishPolicy.AUTO_PUBLISH,
      scorecard: null,
      issues: [],
    });
    expect(decision.autoApproved).toBe(true);
    expect(decision.approvalState).toBe("NOT_REQUIRED");
  });

  it("auto-approves a strong scorecard under smart approval", () => {
    const decision = decideApproval({
      policy: PublishPolicy.SMART_APPROVAL,
      scorecard: goodScorecard,
      issues: [],
    });
    expect(decision.autoApproved).toBe(true);
  });

  it("sends a weak scorecard to a person under smart approval", () => {
    const decision = decideApproval({
      policy: PublishPolicy.SMART_APPROVAL,
      scorecard: { ...goodScorecard, hook: 3, clarity: 4 },
      issues: [],
    });
    expect(decision.autoApproved).toBe(false);
    expect(decision.reason).toMatch(/below the 8 threshold/);
  });

  it("sends anything with a platform warning to a person under smart approval", () => {
    const decision = decideApproval({
      policy: PublishPolicy.SMART_APPROVAL,
      scorecard: goodScorecard,
      issues: [{ severity: "warning", message: "will be cropped" }],
    });
    expect(decision.autoApproved).toBe(false);
    expect(decision.reason).toMatch(/warnings/);
  });

  it("requires a human when there is no scorecard at all", () => {
    const decision = decideApproval({
      policy: PublishPolicy.SMART_APPROVAL,
      scorecard: null,
      issues: [],
    });
    expect(decision.autoApproved).toBe(false);
  });

  it("averages only the numeric scorecard dimensions", () => {
    expect(averageScore({ hook: 8, clarity: 10, notes: ["x"] })).toBe(9);
    expect(averageScore(null)).toBeNull();
    expect(averageScore("nonsense")).toBeNull();
  });
});

describe("idempotency keys", () => {
  it("is stable for a destination and unique between destinations", () => {
    expect(idempotencyKeyFor("abc")).toBe(idempotencyKeyFor("abc"));
    expect(idempotencyKeyFor("abc")).not.toBe(idempotencyKeyFor("abd"));
  });
});

describe("queue job ids", () => {
  // BullMQ refuses a custom id containing ":", and the resulting add() failure is
  // easy to miss behind a fallback path. This is the guard against that.
  it("never emits a colon", () => {
    expect(queueJobId("analyze", "abc123")).toBe("analyze-abc123");
    expect(queueJobId("publish:thing", "retry", 2)).not.toContain(":");
    expect(queueJobId("a:b:c")).toBe("a-b-c");
  });

  it("collapses whitespace and drops empty parts", () => {
    expect(queueJobId("connect", "", "id")).toBe("connect-id");
    expect(queueJobId("a b", 1)).toBe("a-b-1");
  });

  it("is stable for the same parts", () => {
    expect(queueJobId("analyze", "x")).toBe(queueJobId("analyze", "x"));
  });
});

describe("analytics windows", () => {
  const now = new Date("2026-09-10T12:00:00Z");

  it("only reports windows the post is old enough to have reached", () => {
    expect(dueWindows(new Date("2026-09-10T11:30:00Z"), now)).toEqual([]);
    expect(dueWindows(new Date("2026-09-10T10:00:00Z"), now)).toEqual(["1h"]);
    expect(dueWindows(new Date("2026-09-08T12:00:00Z"), now)).toEqual(["1h", "24h"]);
    expect(dueWindows(new Date("2026-07-10T12:00:00Z"), now)).toEqual([
      "1h",
      "24h",
      "7d",
      "30d",
    ]);
  });
});

describe("aggregation maths", () => {
  it("computes a median for odd and even counts", () => {
    expect(median([5])).toBe(5);
    expect(median([1, 3, 5])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("zero-fills every day in the range", () => {
    const series = dailySeries([], 7);
    expect(series).toHaveLength(7);
    expect(series.every((point) => point.views === 0 && point.posts === 0)).toBe(true);
    // Dates must be ascending and unique.
    const dates = series.map((point) => point.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(7);
  });

  it("withholds a momentum figure below six posts", () => {
    const facts = Array.from({ length: 5 }, (_, index) =>
      fakeFact({ views: 1000 * (index + 1) }),
    );
    expect(recentMomentum(facts)).toBeNull();
  });

  it("reports momentum once there are enough posts", () => {
    const older = Array.from({ length: 6 }, () => fakeFact({ views: 1000, daysAgo: 40 }));
    const recent = Array.from({ length: 5 }, () => fakeFact({ views: 4000, daysAgo: 1 }));
    const momentum = recentMomentum([...older, ...recent]);

    expect(momentum).not.toBeNull();
    expect(momentum!).toBeGreaterThan(1);
  });
});

describe("learning engine feature extraction", () => {
  it("classifies hook patterns", () => {
    expect(classifyHook("POV: you cancelled the retainer.")).toBe("pov");
    expect(classifyHook("Would you pay $29 instead of $2,000?")).toBe("problem_solution");
    expect(classifyHook("How long does this take you?")).toBe("question");
    expect(classifyHook("Nobody needs another tool.")).toBe("contrarian");
    expect(classifyHook("31 posts in 4 hours.")).toBe("numeric");
    expect(classifyHook("This is the dashboard.")).toBe("direct");
  });

  it("buckets runtimes and returns null when duration is unknown", () => {
    expect(classifyLength(12)).toBe("0-15");
    expect(classifyLength(24)).toBe("16-25");
    expect(classifyLength(120)).toBe("60+");
    expect(classifyLength(null)).toBeNull();
  });

  it("buckets posting hours into named windows", () => {
    expect(classifyHour(7)).toBe("early");
    expect(classifyHour(19)).toBe("evening");
    expect(classifyHour(2)).toBe("overnight");
  });

  it("normalises CTAs to their action", () => {
    expect(classifyCta("Comment AI and we'll send it")).toBe("comment");
    // "link in bio" is checked before "join", so a CTA containing both is
    // grouped by the destination rather than the verb.
    expect(classifyCta("Join the beta — link in bio")).toBe("link_in_bio");
    expect(classifyCta("Join the waitlist")).toBe("join");
    expect(classifyCta("Try it free")).toBe("try");
    expect(classifyCta("")).toBe("none");
  });
});

describe("confidence assignment", () => {
  it("caps everything at low until the project has enough posts", () => {
    const result = assignConfidence({
      sampleSize: 40,
      liftVsMedian: 3,
      datasetSize: MIN_DATASET - 1,
    });
    expect(result.confidence).toBe(Confidence.LOW);
    expect(result.reason).toMatch(new RegExp(String(MIN_DATASET)));
  });

  it("needs both sample size and effect size for high confidence", () => {
    expect(
      assignConfidence({ sampleSize: 20, liftVsMedian: 1.02, datasetSize: 50 }).confidence,
    ).toBe(Confidence.LOW);
    expect(
      assignConfidence({ sampleSize: 3, liftVsMedian: 2.5, datasetSize: 50 }).confidence,
    ).toBe(Confidence.LOW);
    expect(
      assignConfidence({ sampleSize: 10, liftVsMedian: 1.5, datasetSize: 50 }).confidence,
    ).toBe(Confidence.HIGH);
  });

  it("treats a large drop as just as significant as a large rise", () => {
    expect(
      assignConfidence({ sampleSize: 12, liftVsMedian: 0.6, datasetSize: 60 }).confidence,
    ).toBe(Confidence.HIGH);
  });

  it("gives medium confidence to a moderate effect on a moderate sample", () => {
    expect(
      assignConfidence({ sampleSize: 5, liftVsMedian: 1.2, datasetSize: 40 }).confidence,
    ).toBe(Confidence.MEDIUM);
  });
});

// ---------------------------------------------------------------------------

function fakeFact(options: { views: number; daysAgo?: number }) {
  const publishedAt = new Date();
  publishedAt.setDate(publishedAt.getDate() - (options.daysAgo ?? 1));
  return {
    postId: "p",
    postPlatformId: `pp-${Math.random()}`,
    projectId: "proj",
    projectName: "Test",
    projectAccent: "#9085e9",
    platform: Platform.TIKTOK,
    assetId: "a",
    title: "t",
    hook: "A hook.",
    cta: "Link in bio",
    caption: "c",
    hashtags: [],
    variantLabel: "v",
    format: null,
    durationSeconds: 24,
    publishedAt,
    publishedHour: publishedAt.getHours(),
    publishedDayOfWeek: publishedAt.getDay(),
    windowLabel: "24h",
    source: "SIMULATED" as const,
    views: options.views,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    profileVisits: 0,
    linkClicks: 0,
    conversions: 0,
    followerDelta: 0,
    completionRate: 0.5,
    watchTimeSeconds: 0,
    engagementRate: 0,
  };
}
