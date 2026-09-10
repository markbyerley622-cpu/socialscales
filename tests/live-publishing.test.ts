import { describe, expect, it } from "vitest";
import {
  AdapterFailure,
  isRetryableCategory,
} from "@/server/platforms/types";
import { classifyError } from "@/server/automation/publish-runner";
import { statusForProbe } from "@/server/automation/connect-account";
import {
  assertDedicatedProfile,
  profileDirFor,
  profileKeyFor,
} from "@/server/automation/browser";
import { extractHandle, extractVideoId, tiktokAdapter } from "@/server/platforms/tiktok";
import { describeCandidate } from "@/server/platforms/dom";
import { queueJobId } from "@/server/jobs/queues";
import { AccountStatus, FailureCategory } from "@/generated/prisma/enums";

/**
 * Pure-logic coverage for the live-publishing phase.
 *
 * Everything here is decidable without a browser or a platform: classification,
 * the states a probe is allowed to justify, profile isolation, and the URL
 * parsing that turns a TikTok link into an authoritative post id.
 */

describe("failure classification", () => {
  it("takes the adapter's own category rather than re-deriving one", () => {
    const failure = new AdapterFailure(
      "Could not find the post button",
      FailureCategory.SELECTOR_DRIFT,
      "METADATA_ENTERED",
    );
    expect(classifyError(failure)).toEqual({
      category: FailureCategory.SELECTOR_DRIFT,
      stage: "METADATA_ENTERED",
    });
  });

  it("recognises a media rejection", () => {
    expect(
      classifyError(new Error("Media rejected for TikTok: 400s exceeds the maximum")),
    ).toMatchObject({ category: FailureCategory.MEDIA_REJECTED });
  });

  it("recognises a dead session", () => {
    expect(
      classifyError(new Error("TikTok session is no longer valid. Reconnect the account.")),
    ).toMatchObject({ category: FailureCategory.AUTH_SESSION });
    expect(
      classifyError(new Error("No stored browser session for account abc")),
    ).toMatchObject({ category: FailureCategory.AUTH_SESSION });
  });

  it("recognises a transient network or timeout error", () => {
    for (const message of [
      "Timeout 30000ms exceeded",
      // "timed out" rather than "timeout" — the phrasing that originally slipped
      // through and got classified as UNKNOWN.
      "composer confirmation timed out",
      "net::ERR_CONNECTION_RESET",
      "getaddrinfo ENOTFOUND www.tiktok.com",
      "getaddrinfo EAI_AGAIN www.tiktok.com",
    ]) {
      expect(classifyError(new Error(message))).toMatchObject({
        category: FailureCategory.TRANSIENT,
      });
    }
  });

  it("falls back to UNKNOWN rather than guessing something specific", () => {
    expect(classifyError(new Error("something nobody anticipated"))).toEqual({
      category: FailureCategory.UNKNOWN,
      stage: null,
    });
  });

  it("only retries categories where a retry could plausibly work", () => {
    expect(isRetryableCategory(FailureCategory.TRANSIENT)).toBe(true);
    expect(isRetryableCategory(FailureCategory.UNKNOWN)).toBe(true);

    // Retrying these is either useless or actively dangerous.
    for (const category of [
      FailureCategory.AUTH_SESSION,
      FailureCategory.SELECTOR_DRIFT,
      FailureCategory.MEDIA_REJECTED,
      FailureCategory.HUMAN_ACTION_REQUIRED,
      FailureCategory.BLOCKED_DISCONNECTED,
      FailureCategory.PLATFORM_REJECTED,
    ]) {
      expect(isRetryableCategory(category)).toBe(false);
    }
  });

  it("never retries a platform rejection, because the post may already exist", () => {
    // This is the duplicate-post hazard: TikTok accepted the submission but the
    // post could not be confirmed. Retrying blind could publish twice.
    expect(isRetryableCategory(FailureCategory.PLATFORM_REJECTED)).toBe(false);
  });
});

describe("probe state to account status", () => {
  it("only AUTHENTICATED justifies CONNECTED", () => {
    expect(statusForProbe("AUTHENTICATED")).toBe(AccountStatus.CONNECTED);
    expect(statusForProbe("CHALLENGE")).toBe(AccountStatus.CHALLENGE);
    expect(statusForProbe("UNAUTHENTICATED")).toBe(AccountStatus.NEEDS_REAUTH);
    // An inconclusive probe must never be reported as a working connection.
    expect(statusForProbe("UNKNOWN")).toBe(AccountStatus.ERROR);
  });

  it("has no state that maps an unverified session to CONNECTED", () => {
    const states = ["AUTHENTICATED", "UNAUTHENTICATED", "CHALLENGE", "UNKNOWN"] as const;
    const connected = states.filter(
      (state) => statusForProbe(state) === AccountStatus.CONNECTED,
    );
    expect(connected).toEqual(["AUTHENTICATED"]);
  });
});

describe("automation profile isolation", () => {
  it("derives a per-account profile under the app's own storage", () => {
    const dir = profileDirFor("acct_123");
    expect(dir).toMatch(/browser-profiles/);
    expect(dir).toMatch(/acct_123$/);
    expect(profileKeyFor("acct_123")).toBe("browser-profiles/acct_123");
  });

  it("accepts a profile it derived itself", () => {
    expect(() => assertDedicatedProfile(profileDirFor("acct_456"))).not.toThrow();
  });

  it("refuses a real Chrome profile", () => {
    expect(() =>
      assertDedicatedProfile("C:\\Users\\someone\\AppData\\Local\\Google\\Chrome\\User Data"),
    ).toThrow(/dedicated profile/i);
    expect(() =>
      assertDedicatedProfile("/home/someone/.config/google-chrome"),
    ).toThrow(/dedicated profile/i);
  });

  it("refuses any path outside the profile root", () => {
    expect(() => assertDedicatedProfile("/tmp/whatever")).toThrow(/dedicated profile/i);
    // Traversal out of the root must not sneak past.
    expect(() =>
      assertDedicatedProfile(`${profileDirFor("x")}/../../../elsewhere`),
    ).toThrow(/dedicated profile/i);
  });
});

describe("TikTok URL parsing", () => {
  it("extracts the video id from a canonical post URL", () => {
    expect(
      extractVideoId("https://www.tiktok.com/@someone/video/7412345678901234567"),
    ).toBe("7412345678901234567");
    expect(extractVideoId("/@someone/video/7412345678901234567?is_from=x")).toBe(
      "7412345678901234567",
    );
  });

  it("returns null for anything that is not a post URL", () => {
    expect(extractVideoId("https://www.tiktok.com/@someone")).toBeNull();
    expect(extractVideoId("https://www.tiktok.com/tiktokstudio/content")).toBeNull();
    // Too short to be a real id.
    expect(extractVideoId("/video/123")).toBeNull();
  });

  it("extracts the handle", () => {
    expect(extractHandle("https://www.tiktok.com/@creator.ai/video/7412345678901234")).toBe(
      "@creator.ai",
    );
    expect(extractHandle("https://www.tiktok.com/tiktokstudio")).toBeNull();
  });
});

describe("TikTok adapter contract", () => {
  it("declares browser-assisted publishing and implements verification", () => {
    expect(tiktokAdapter.capabilities.publish).toBe("BROWSER_ASSISTED");
    // Publishing without a way to confirm it would mean trusting a button click.
    expect(typeof tiktokAdapter.verifyPublication).toBe("function");
  });

  it("declares metrics support and implements a collector", () => {
    expect(tiktokAdapter.capabilities.metrics).toBe("BROWSER_ASSISTED");
    expect(typeof tiktokAdapter.collectMetrics).toBe("function");
  });

  it("points its login and composer at TikTok's own pages", () => {
    expect(tiktokAdapter.loginUrl).toMatch(/^https:\/\/www\.tiktok\.com\//);
    expect(tiktokAdapter.composerUrl).toMatch(/tiktokstudio\/upload$/);
    expect(tiktokAdapter.sessionProbeUrl).toMatch(/tiktokstudio$/);
  });
});

describe("selector candidates", () => {
  it("describes each candidate kind for diagnostics", () => {
    expect(describeCandidate({ kind: "role", role: "button", name: /post/i })).toContain(
      "role=button",
    );
    expect(describeCandidate({ kind: "testId", value: "post_video_button" })).toBe(
      "data-e2e=post_video_button",
    );
    expect(describeCandidate({ kind: "css", selector: 'input[type="file"]' })).toContain(
      "css=",
    );
    expect(describeCandidate({ kind: "label", text: "Caption" })).toBe("label=Caption");
  });
});

describe("queue job ids", () => {
  it("stays colon-free for the ids this phase introduced", () => {
    expect(queueJobId("connect", "acct_1", 1234)).toBe("connect-acct_1-1234");
    expect(queueJobId("verify", "acct_1")).not.toContain(":");
  });
});
