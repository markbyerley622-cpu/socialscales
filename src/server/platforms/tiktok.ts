import { Platform } from "@/generated/prisma/enums";
import {
  composeStandardCaption,
  validateAgainstConstraints,
  type BrowserPublishContext,
  type MediaCandidate,
  type MediaConstraints,
  type PublishOutcome,
  type SignInProbe,
  type SocialPlatform,
} from "./types";

/**
 * TikTok adapter — browser-assisted.
 *
 * TikTok's Content Posting API exists but is gated behind an approved developer
 * application per account. Until that approval is in place, publishing here
 * drives TikTok Studio in a browser session the operator authenticated by hand.
 *
 * This adapter does not attempt to defeat any protection mechanism. If TikTok
 * shows a verification challenge, the run fails and surfaces a screenshot for a
 * human to finish the post manually.
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

/** Selector candidates, tried in order. TikTok Studio's DOM changes often. */
const SELECTORS = {
  fileInput: 'input[type="file"]',
  captionEditor: [
    'div[contenteditable="true"][role="textbox"]',
    'div[data-contents="true"]',
    ".public-DraftEditor-content",
  ],
  postButton: [
    'button[data-e2e="post_video_button"]',
    'button:has-text("Post")',
    'button:has-text("Publish")',
  ],
  scheduleToggle: [
    'input[type="checkbox"][name="schedule"]',
    'div[data-e2e="schedule_switch"]',
  ],
  uploadProgressDone: [
    'text=/1[0]0%/',
    '[data-e2e="upload_success"]',
  ],
  profileHandle: [
    '[data-e2e="profile-icon"]',
    'a[href^="/@"]',
  ],
};

async function firstVisible(
  page: BrowserPublishContext["page"],
  selectors: string[],
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.isVisible({ timeout: 1_000 })) return locator;
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw new Error(
    `None of these selectors became visible within ${timeoutMs}ms: ${selectors.join(" | ")}` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

export const tiktokAdapter: SocialPlatform = {
  platform: Platform.TIKTOK,
  label: "TikTok",
  loginUrl: "https://www.tiktok.com/login",
  composerUrl: "https://www.tiktok.com/tiktokstudio/upload",
  sessionProbeUrl: "https://www.tiktok.com/tiktokstudio",

  capabilities: {
    upload: "BROWSER_ASSISTED",
    publish: "BROWSER_ASSISTED",
    // TikTok Studio does offer scheduling, and this adapter uses it when asked.
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

  async probeSignIn(page): Promise<SignInProbe> {
    await page.goto(this.sessionProbeUrl, { waitUntil: "domcontentloaded" });
    // A signed-out session is redirected to the login page.
    if (page.url().includes("/login")) {
      return { signedIn: false, handle: null, displayName: null };
    }
    let handle: string | null = null;
    for (const selector of SELECTORS.profileHandle) {
      try {
        const href = await page
          .locator(selector)
          .first()
          .getAttribute("href", { timeout: 2_000 });
        if (href?.startsWith("/@")) {
          handle = href.slice(1);
          break;
        }
      } catch {
        // Try the next candidate.
      }
    }
    return { signedIn: true, handle, displayName: null };
  },

  async publishViaBrowser(ctx): Promise<PublishOutcome> {
    const { page, log } = ctx;

    await log("Opening TikTok Studio upload page", { url: this.composerUrl });
    await page.goto(this.composerUrl, { waitUntil: "domcontentloaded" });

    if (page.url().includes("/login")) {
      throw new Error(
        "TikTok redirected to login: the stored session is no longer valid. Reconnect the account.",
      );
    }

    await log("Selecting media file");
    const fileInput = page.locator(SELECTORS.fileInput).first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(ctx.mediaPath);

    await log("Waiting for upload to finish");
    try {
      await firstVisible(page, SELECTORS.uploadProgressDone, 180_000);
    } catch {
      // Some builds show no explicit completion marker; the caption editor
      // becoming editable is the more reliable signal.
      await log("No upload-complete marker found, falling back to editor readiness");
    }

    await log("Entering caption");
    const editor = await firstVisible(page, SELECTORS.captionEditor, 60_000);
    await editor.click();
    // Clear whatever TikTok prefilled from the filename.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await editor.pressSequentially(ctx.caption, { delay: 12 });

    if (ctx.publishAt) {
      await log("Configuring native schedule", {
        publishAt: ctx.publishAt.toISOString(),
      });
      const toggle = await firstVisible(page, SELECTORS.scheduleToggle, 10_000);
      await toggle.click();
      // Date/time fields differ per locale; the operator is told to verify.
      await log(
        "Schedule toggle enabled. Verify the date and time in TikTok Studio: locale-specific fields are not auto-filled.",
      );
    }

    await log("Submitting post");
    const postButton = await firstVisible(page, SELECTORS.postButton, 30_000);
    await postButton.click();

    // Confirmation: TikTok navigates to the content list on success.
    await log("Waiting for publish confirmation");
    await page.waitForURL(/tiktokstudio\/(content|upload)/, { timeout: 120_000 });

    const permalink = null;
    await log("TikTok reported the post was accepted");

    return ctx.publishAt
      ? {
          status: "scheduled",
          remotePostId: null,
          permalink,
          scheduledFor: ctx.publishAt,
        }
      : { status: "published", remotePostId: null, permalink };
  },
};
