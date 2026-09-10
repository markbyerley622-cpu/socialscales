import type { Page } from "playwright";
import { Platform } from "@/generated/prisma/enums";
import {
  AdapterFailure,
  composeStandardCaption,
  validateAgainstConstraints,
  type MediaCandidate,
  type MediaConstraints,
  type MetricsSample,
  type PublicationEvidence,
  type PublishOutcome,
  type SignInProbe,
  type SocialPlatform,
} from "./types";
import { clickTarget, isPresent, resolve, safeUrl, type Target } from "./dom";

/**
 * TikTok adapter — browser-assisted.
 *
 * TikTok's Content Posting API is gated behind a per-account approved developer
 * application. Until that approval exists, publishing drives TikTok Studio in a
 * browser session the operator authenticated by hand, in a dedicated automation
 * profile that is never the operator's personal Chrome profile.
 *
 * This adapter does not attempt to defeat any protection mechanism. There is no
 * fingerprint spoofing, no stealth patching and no challenge solving. If TikTok
 * presents a verification step, the run stops and reports
 * HUMAN_ACTION_REQUIRED so a person can clear it.
 *
 * Selector strategy: every target is a list of candidates ordered
 * semantic-role → data-e2e → structure → text, resolved by `dom.resolve`, which
 * reports exactly what it tried when the layout drifts.
 */

const constraints: MediaConstraints = {
  maxSizeBytes: 4 * 1024 * 1024 * 1024,
  minDurationSeconds: 1,
  maxDurationSeconds: 60 * 10,
  acceptedMimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
  preferredAspectRatios: ["9:16"],
  captionMaxLength: 2200,
  hashtagMaxCount: 8,
};

const STUDIO_ORIGIN = "https://www.tiktok.com";
const UPLOAD_URL = `${STUDIO_ORIGIN}/tiktokstudio/upload`;
const CONTENT_URL = `${STUDIO_ORIGIN}/tiktokstudio/content`;
const STUDIO_HOME = `${STUDIO_ORIGIN}/tiktokstudio`;

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const T = {
  fileInput: {
    description: "upload file input",
    candidates: [
      { kind: "css", selector: 'input[type="file"][accept*="video"]' },
      { kind: "css", selector: 'input[type="file"]' },
    ],
  } satisfies Target,

  captionEditor: {
    description: "caption editor",
    candidates: [
      { kind: "role", role: "textbox", name: /caption|description/i },
      { kind: "testId", value: "caption_container" },
      { kind: "css", selector: 'div[contenteditable="true"][role="textbox"]' },
      { kind: "css", selector: ".public-DraftEditor-content" },
    ],
  } satisfies Target,

  postButton: {
    description: "post button",
    candidates: [
      { kind: "testId", value: "post_video_button" },
      { kind: "role", role: "button", name: /^post$/i },
      { kind: "role", role: "button", name: /^publish$/i },
      { kind: "role", role: "button", name: /^schedule$/i },
    ],
  } satisfies Target,

  scheduleToggle: {
    description: "schedule toggle",
    candidates: [
      { kind: "role", role: "switch", name: /schedule/i },
      { kind: "role", role: "radio", name: /schedule/i },
      { kind: "testId", value: "schedule_switch" },
      { kind: "css", selector: 'input[type="checkbox"][name="schedule"]' },
    ],
  } satisfies Target,

  uploadComplete: {
    description: "upload completion marker",
    candidates: [
      { kind: "testId", value: "upload_success" },
      { kind: "text", value: /uploaded|100%/i },
    ],
  } satisfies Target,

  /** Anything that means "a human must act". */
  challenge: {
    description: "verification challenge",
    candidates: [
      { kind: "css", selector: "#captcha-verify-container" },
      { kind: "css", selector: '[id*="captcha"]' },
      { kind: "css", selector: '[class*="captcha_verify"]' },
      { kind: "text", value: /verify to continue|security check|drag the slider/i },
      { kind: "text", value: /confirm it'?s you|verification code/i },
    ],
  } satisfies Target,

  loginForm: {
    description: "login form",
    candidates: [
      { kind: "role", role: "button", name: /log in|sign up/i },
      { kind: "css", selector: 'input[name="username"]' },
      { kind: "text", value: /log in to tiktok/i },
    ],
  } satisfies Target,

  studioShell: {
    description: "authenticated Studio shell",
    candidates: [
      { kind: "role", role: "link", name: /upload/i },
      { kind: "testId", value: "profile-icon" },
      { kind: "css", selector: 'a[href*="/tiktokstudio/content"]' },
    ],
  } satisfies Target,

  postRows: {
    description: "content list rows",
    candidates: [
      { kind: "css", selector: 'a[href*="/video/"]' },
      { kind: "testId", value: "content-list-item" },
    ],
  } satisfies Target,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extracts the numeric video id from any TikTok post URL. */
export function extractVideoId(href: string): string | null {
  const match = href.match(/\/video\/(\d{6,})/);
  return match ? match[1] : null;
}

/** Extracts the @handle from a TikTok profile or post URL. */
export function extractHandle(href: string): string | null {
  const match = href.match(/\/@([A-Za-z0-9._]{1,30})/);
  return match ? `@${match[1]}` : null;
}

/** Throws HUMAN_ACTION_REQUIRED if TikTok is showing a verification step. */
async function assertNoChallenge(
  page: Page,
  stage: Parameters<typeof clickTarget>[2]["stage"],
): Promise<void> {
  if (await isPresent(page, T.challenge, 1_500)) {
    throw new AdapterFailure(
      "TikTok is showing a verification challenge. This system does not attempt to " +
        "solve or bypass it — sign in to the automation profile and clear it by hand, " +
        "then retry.",
      "HUMAN_ACTION_REQUIRED",
      stage,
      { url: safeUrl(page) },
    );
  }
}

async function assertNotLoggedOut(
  page: Page,
  stage: Parameters<typeof clickTarget>[2]["stage"],
): Promise<void> {
  if (page.url().includes("/login") || (await isPresent(page, T.loginForm, 1_000))) {
    throw new AdapterFailure(
      "TikTok redirected to the login page: the stored session is no longer valid. " +
        "Reconnect the account.",
      "AUTH_SESSION",
      stage,
      { url: safeUrl(page) },
    );
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const tiktokAdapter: SocialPlatform = {
  platform: Platform.TIKTOK,
  label: "TikTok",
  loginUrl: `${STUDIO_ORIGIN}/login`,
  composerUrl: UPLOAD_URL,
  sessionProbeUrl: STUDIO_HOME,

  capabilities: {
    upload: "BROWSER_ASSISTED",
    publish: "BROWSER_ASSISTED",
    nativeSchedule: "BROWSER_ASSISTED",
    metrics: "BROWSER_ASSISTED",
    checkStatus: "BROWSER_ASSISTED",
  },

  constraints,

  validateMedia(candidate: MediaCandidate) {
    return validateAgainstConstraints(candidate, constraints, "TikTok");
  },

  composeCaption(input) {
    return composeStandardCaption(input, constraints);
  },

  /**
   * Determines whether the loaded session can actually be used.
   *
   * Returns AUTHENTICATED only on positive evidence — the Studio shell rendering
   * for a signed-in user. A stored session blob existing is not evidence, and a
   * page that merely failed to load is UNKNOWN rather than authenticated.
   */
  async probeSignIn(page): Promise<SignInProbe> {
    try {
      await page.goto(this.sessionProbeUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    } catch (error) {
      return {
        state: "UNKNOWN",
        handle: null,
        displayName: null,
        platformAccountId: null,
        evidence: `Could not load ${this.sessionProbeUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (await isPresent(page, T.challenge, 2_000)) {
      return {
        state: "CHALLENGE",
        handle: null,
        displayName: null,
        platformAccountId: null,
        evidence: `Verification challenge present at ${safeUrl(page)}`,
      };
    }

    if (page.url().includes("/login") || (await isPresent(page, T.loginForm, 2_000))) {
      return {
        state: "UNAUTHENTICATED",
        handle: null,
        displayName: null,
        platformAccountId: null,
        evidence: `Redirected to login (${safeUrl(page)})`,
      };
    }

    const authenticated = await isPresent(page, T.studioShell, 8_000);
    if (!authenticated) {
      return {
        state: "UNKNOWN",
        handle: null,
        displayName: null,
        platformAccountId: null,
        evidence:
          `Loaded ${safeUrl(page)} but found neither the Studio shell nor a login form. ` +
          "Treating as unusable rather than assuming a good session.",
      };
    }

    // Read the handle from whichever profile link is present.
    let handle: string | null = null;
    try {
      const hrefs = await page
        .locator('a[href*="/@"]')
        .evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLAnchorElement).getAttribute("href") ?? ""),
        );
      for (const href of hrefs) {
        const found = extractHandle(href);
        if (found) {
          handle = found;
          break;
        }
      }
    } catch {
      // Handle stays null; the operator-entered handle stands.
    }

    return {
      state: "AUTHENTICATED",
      handle,
      displayName: null,
      // TikTok does not expose a stable numeric account id in Studio's DOM; the
      // handle is the identifier we can actually observe.
      platformAccountId: handle,
      evidence: `Studio shell rendered at ${safeUrl(page)}${handle ? ` as ${handle}` : ""}`,
    };
  },

  async publishViaBrowser(ctx): Promise<PublishOutcome> {
    const { page, log } = ctx;

    await log("Opening TikTok Studio upload page", { url: UPLOAD_URL });
    try {
      await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (error) {
      throw new AdapterFailure(
        `Could not load the TikTok upload page: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "TRANSIENT",
        "COMPOSER_OPENED",
        { url: UPLOAD_URL },
      );
    }

    await assertNotLoggedOut(page, "COMPOSER_OPENED");
    await assertNoChallenge(page, "COMPOSER_OPENED");
    await log("Composer opened");

    // --- Media ------------------------------------------------------------
    await log("Selecting media file");
    const { locator: fileInput, via: inputVia } = await resolve(page, T.fileInput, {
      stage: "COMPOSER_OPENED",
      requireVisible: false,
      timeoutMs: 30_000,
    });
    await fileInput.setInputFiles(ctx.mediaPath);
    await log("Media handed to the file input", { via: inputVia });

    await log("Waiting for upload to finish");
    const uploaded = await isPresent(page, T.uploadComplete, 180_000);
    if (!uploaded) {
      // Not fatal: some builds show no explicit marker, and the caption editor
      // becoming editable is the more reliable readiness signal.
      await log("No upload-complete marker; falling back to editor readiness");
    }
    await assertNoChallenge(page, "MEDIA_UPLOADED");

    // --- Caption ----------------------------------------------------------
    await log("Entering caption");
    const { locator: editor, via: editorVia } = await resolve(page, T.captionEditor, {
      stage: "MEDIA_UPLOADED",
      timeoutMs: 90_000,
    });
    await editor.click();
    // Clear whatever TikTok prefilled from the filename.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await editor.pressSequentially(ctx.caption, { delay: 12 });
    await log("Caption entered", { via: editorVia, characters: ctx.caption.length });

    // --- Native schedule --------------------------------------------------
    if (ctx.publishAt) {
      await log("Enabling TikTok's own scheduler", {
        publishAt: ctx.publishAt.toISOString(),
      });
      const via = await clickTarget(page, T.scheduleToggle, {
        stage: "METADATA_ENTERED",
        timeoutMs: 15_000,
      });
      await log(
        "Schedule toggle enabled. TikTok's date and time fields are locale-specific and " +
          "are not auto-filled — confirm them in Studio.",
        { via },
      );
    }

    await assertNoChallenge(page, "METADATA_ENTERED");

    // --- Submit -----------------------------------------------------------
    await log("Submitting post");
    const postVia = await clickTarget(page, T.postButton, {
      stage: "METADATA_ENTERED",
      timeoutMs: 30_000,
    });
    await log("Post button clicked", { via: postVia });

    // A click is not proof. Wait for TikTok's own navigation, then verify.
    try {
      await page.waitForURL(/tiktokstudio\/(content|upload)/, { timeout: 120_000 });
    } catch {
      await log("No post-submit navigation observed; verifying against the content list");
    }
    await assertNoChallenge(page, "SUBMITTED");

    const verification = await this.verifyPublication!({
      page,
      remotePostId: null,
      caption: ctx.caption,
      log,
    });

    if (!verification) {
      throw new AdapterFailure(
        "TikTok accepted the submission but the post could not be found in the content " +
          "list afterwards, so publication is unconfirmed. Check the account before retrying: " +
          "a retry could duplicate the post if it did in fact publish.",
        "PLATFORM_REJECTED",
        "SUBMITTED",
        { url: safeUrl(page) },
      );
    }

    await log("Publication verified on TikTok", {
      remotePostId: verification.remotePostId,
      permalink: verification.permalink,
    });

    const platformAccountId = verification.permalink
      ? extractHandle(verification.permalink)
      : null;

    if (ctx.publishAt) {
      return {
        status: "scheduled",
        remotePostId: verification.remotePostId,
        permalink: verification.permalink,
        platformAccountId,
        scheduledFor: ctx.publishAt,
        verification,
      };
    }

    return {
      status: "published",
      remotePostId: verification.remotePostId,
      permalink: verification.permalink,
      platformAccountId,
      verification,
    };
  },

  /**
   * Confirms a publication by re-reading TikTok's own content list.
   *
   * This is the difference between "the button click did not throw" and "the
   * post exists". When a remote id is known it is matched exactly; otherwise the
   * newest row is taken, which is correct here because the runner publishes one
   * post at a time per account.
   */
  async verifyPublication({ page, remotePostId, log }): Promise<PublicationEvidence | null> {
    await log("Verifying publication against the TikTok content list");
    try {
      await page.goto(CONTENT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (error) {
      await log("Could not load the content list", { reason: String(error) });
      return null;
    }

    if (await isPresent(page, T.challenge, 1_500)) {
      throw new AdapterFailure(
        "TikTok is showing a verification challenge on the content list, so publication " +
          "could not be confirmed.",
        "HUMAN_ACTION_REQUIRED",
        "SUBMITTED",
        { url: safeUrl(page) },
      );
    }

    let hrefs: string[] = [];
    try {
      await resolve(page, T.postRows, {
        stage: "SUBMITTED",
        timeoutMs: 30_000,
        requireVisible: false,
      });
      hrefs = await page
        .locator('a[href*="/video/"]')
        .evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLAnchorElement).href).filter(Boolean),
        );
    } catch {
      await log("No post rows found in the content list");
      return null;
    }

    const seen: string[] = [];
    for (const href of hrefs) {
      const id = extractVideoId(href);
      if (!id) continue;
      seen.push(id);
      if (remotePostId && id === remotePostId) {
        return {
          method: "studio-content-list",
          remotePostId: id,
          permalink: href,
          publishedAt: new Date(),
          observed: `Matched video ${id} in the TikTok Studio content list`,
        };
      }
    }

    if (remotePostId) {
      await log("Known post id was not present in the content list", {
        lookingFor: remotePostId,
        found: seen.length,
      });
      return null;
    }

    const newest = hrefs.find((href) => extractVideoId(href));
    if (!newest) return null;

    return {
      method: "studio-content-list-newest",
      remotePostId: extractVideoId(newest),
      permalink: newest,
      publishedAt: new Date(),
      observed:
        `Newest entry in the TikTok Studio content list after submitting ` +
        `(${seen.length} entries visible)`,
    };
  },

  /**
   * Reads the operator's own post analytics from TikTok Studio.
   *
   * This reads data TikTok shows the account owner about their own post in a
   * session that owner authenticated. It is not scraping third-party or private
   * data. Values that Studio does not display are left absent rather than
   * invented — the analytics model treats a missing metric as missing.
   */
  async collectMetrics({ page, remotePostId, log }): Promise<Partial<MetricsSample>> {
    const url = `${STUDIO_ORIGIN}/tiktokstudio/analytics/content/${remotePostId}`;
    await log("Reading post analytics", { remotePostId });

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (error) {
      throw new AdapterFailure(
        `Could not load TikTok analytics for ${remotePostId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "TRANSIENT",
        "VERIFIED",
        { url },
      );
    }

    if (await isPresent(page, T.challenge, 1_500)) {
      throw new AdapterFailure(
        "TikTok is showing a verification challenge on the analytics page.",
        "HUMAN_ACTION_REQUIRED",
        "VERIFIED",
        { url: safeUrl(page) },
      );
    }

    const sample: Partial<MetricsSample> = {};
    const labels: Array<[keyof MetricsSample, RegExp]> = [
      ["views", /video views|views/i],
      ["likes", /likes/i],
      ["comments", /comments/i],
      ["shares", /shares/i],
      ["saves", /saves|favou?rites/i],
    ];

    for (const [key, pattern] of labels) {
      const value = await readStatNear(page, pattern);
      if (value !== null) sample[key] = value;
    }

    await log("Analytics read", {
      found: Object.keys(sample),
      // Absent keys are genuinely unavailable, not zero.
      missing: labels.map(([key]) => key).filter((key) => !(key in sample)),
    });

    return sample;
  },
};

/**
 * Finds a numeric stat rendered next to a label.
 *
 * Studio renders each metric as a label and a value inside a shared container,
 * without stable ids. This walks up from the label to the nearest container that
 * also holds a number, which survives class-name churn.
 */
async function readStatNear(page: Page, pattern: RegExp): Promise<number | null> {
  try {
    return await page.evaluate((source) => {
      const regex = new RegExp(source.pattern, source.flags);
      const parse = (raw: string): number | null => {
        const match = raw
          .replace(/,/g, "")
          .match(/^\s*([\d.]+)\s*([KMB])?\s*$/i);
        if (!match) return null;
        const base = Number.parseFloat(match[1]);
        if (!Number.isFinite(base)) return null;
        const suffix = (match[2] ?? "").toUpperCase();
        const scale = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : 1;
        return Math.round(base * scale);
      };

      const elements: Element[] = Array.from(
        document.querySelectorAll("div,span,p,dt,dd,td,th"),
      );
      for (const element of elements) {
        const text = (element.textContent ?? "").trim();
        if (!regex.test(text) || text.length > 40) continue;

        let node: Element | null = element;
        for (let depth = 0; depth < 4 && node; depth += 1) {
          const parent: Element | null = node.parentElement;
          const siblings: Element[] = parent ? Array.from(parent.children) : [];
          for (const sibling of siblings) {
            if (sibling === node) continue;
            const value = parse(sibling.textContent ?? "");
            if (value !== null) return value;
          }
          node = parent;
        }
      }
      return null;
    }, { pattern: pattern.source, flags: pattern.flags });
  } catch {
    return null;
  }
}
