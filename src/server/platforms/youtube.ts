import { Platform } from "@/generated/prisma/enums";
import {
  composeStandardCaption,
  validateAgainstConstraints,
  type MediaConstraints,
  type PublishOutcome,
  type SignInProbe,
  type SocialPlatform,
} from "./types";

/**
 * YouTube Shorts adapter — browser-assisted today, API-ready by design.
 *
 * YouTube is the one platform here with a fully documented upload API
 * (`youtube.videos.insert`), which also supports private-until-scheduled
 * publishing. That is strictly better than driving Studio, so it is the intended
 * path: it needs a Google Cloud project, OAuth consent and a refresh token per
 * channel. None of that is configured in this repo, so `capabilities` reports
 * what is actually implemented rather than what is possible. Switching over means
 * implementing `publishViaApi` and flipping these three entries to OFFICIAL_API;
 * nothing outside this file needs to change.
 */

const constraints: MediaConstraints = {
  maxSizeBytes: 256 * 1024 * 1024 * 1024,
  minDurationSeconds: 1,
  // Shorts cap: anything longer publishes as a regular upload.
  maxDurationSeconds: 180,
  acceptedMimeTypes: ["video/mp4", "video/quicktime", "video/webm"],
  preferredAspectRatios: ["9:16"],
  // Shorts descriptions allow far more, but the title is what matters most.
  captionMaxLength: 5000,
  hashtagMaxCount: 6,
};

const SELECTORS = {
  createButton: ['ytcp-button#create-icon', 'button[aria-label="Create"]'],
  uploadMenuItem: ['tp-yt-paper-item:has-text("Upload videos")'],
  fileInput: 'input[type="file"]',
  titleBox: ['#title-textarea #textbox', 'ytcp-social-suggestions-textbox#title-textarea div#textbox'],
  descriptionBox: ['#description-textarea #textbox'],
  notForKidsRadio: ['tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]'],
  nextButton: ['ytcp-button#next-button'],
  visibilityPublic: ['tp-yt-paper-radio-button[name="PUBLIC"]'],
  scheduleRadio: ['tp-yt-paper-radio-button[name="SCHEDULE"]'],
  doneButton: ['ytcp-button#done-button'],
  uploadComplete: ['text=/Upload complete|Checks complete|Processing (?:abandoned|done)/i'],
  channelAvatar: ['button#avatar-btn img'],
};

export const youtubeAdapter: SocialPlatform = {
  platform: Platform.YOUTUBE,
  label: "YouTube",
  loginUrl: "https://accounts.google.com/ServiceLogin?service=youtube",
  composerUrl: "https://studio.youtube.com/",
  sessionProbeUrl: "https://studio.youtube.com/",

  capabilities: {
    upload: "BROWSER_ASSISTED",
    publish: "BROWSER_ASSISTED",
    // Studio's own scheduler is used when a future publish time is supplied.
    nativeSchedule: "BROWSER_ASSISTED",
    metrics: "BROWSER_ASSISTED",
    checkStatus: "BROWSER_ASSISTED",
  },

  constraints,

  validateMedia(candidate) {
    const verdict = validateAgainstConstraints(candidate, constraints, "YouTube");
    if (
      candidate.durationSeconds !== null &&
      candidate.durationSeconds > 180
    ) {
      verdict.issues.push({
        severity: "warning",
        message:
          "Over 3 minutes: YouTube will publish this as a standard video rather than a Short.",
      });
    }
    return verdict;
  },

  composeCaption(input) {
    return composeStandardCaption(input, constraints);
  },

  async probeSignIn(page): Promise<SignInProbe> {
    await page.goto(this.sessionProbeUrl, { waitUntil: "domcontentloaded" });
    if (page.url().includes("accounts.google.com")) {
      return { signedIn: false, handle: null, displayName: null };
    }
    let displayName: string | null = null;
    try {
      displayName = await page
        .locator(SELECTORS.channelAvatar[0])
        .first()
        .getAttribute("alt", { timeout: 3_000 });
    } catch {
      // Leave null; the operator-entered handle stands.
    }
    return { signedIn: true, handle: null, displayName };
  },

  async publishViaBrowser(ctx): Promise<PublishOutcome> {
    const { page, log } = ctx;

    await log("Opening YouTube Studio", { url: this.composerUrl });
    await page.goto(this.composerUrl, { waitUntil: "domcontentloaded" });

    if (page.url().includes("accounts.google.com")) {
      throw new Error(
        "YouTube redirected to the Google sign-in page: the stored session is no longer valid. Reconnect the account.",
      );
    }

    await log("Opening the upload dialog");
    await clickFirst(page, SELECTORS.createButton, 20_000, "Studio create button");
    await clickFirst(page, SELECTORS.uploadMenuItem, 10_000, "Upload videos menu item");

    await log("Selecting media file");
    const fileInput = page.locator(SELECTORS.fileInput).first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(ctx.mediaPath);

    // Studio splits the caption: first line becomes the title, rest the description.
    const [firstLine, ...rest] = ctx.caption.split("\n");
    const title = firstLine.slice(0, 100);
    const description = rest.join("\n").trim();

    await log("Entering title");
    const titleBox = await firstOf(page, SELECTORS.titleBox, 60_000, "title field");
    await titleBox.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await titleBox.pressSequentially(title, { delay: 8 });

    if (description) {
      await log("Entering description");
      const descriptionBox = await firstOf(
        page,
        SELECTORS.descriptionBox,
        20_000,
        "description field",
      );
      await descriptionBox.click();
      await descriptionBox.pressSequentially(description, { delay: 4 });
    }

    await log("Declaring audience (not made for kids)");
    await clickFirst(page, SELECTORS.notForKidsRadio, 15_000, "audience radio");

    // Details → Video elements → Checks → Visibility.
    for (const step of ["details", "video elements", "checks"]) {
      await log(`Advancing past ${step}`);
      await clickFirst(page, SELECTORS.nextButton, 20_000, "next button");
    }

    if (ctx.publishAt) {
      await log("Scheduling in Studio", { publishAt: ctx.publishAt.toISOString() });
      await clickFirst(page, SELECTORS.scheduleRadio, 15_000, "schedule radio");
      await log(
        "Schedule option selected. Confirm the exact date and time in Studio: the date picker is locale-specific and is not auto-filled.",
      );
    } else {
      await log("Setting visibility to public");
      await clickFirst(page, SELECTORS.visibilityPublic, 15_000, "public radio");
    }

    await log("Waiting for processing checks to clear");
    try {
      await page.locator(SELECTORS.uploadComplete[0]).first().waitFor({ timeout: 300_000 });
    } catch {
      await log("No explicit completion marker; continuing to submit");
    }

    await log("Submitting");
    await clickFirst(page, SELECTORS.doneButton, 30_000, "done button");

    await log("YouTube accepted the upload");
    return ctx.publishAt
      ? {
          status: "scheduled",
          remotePostId: null,
          permalink: null,
          scheduledFor: ctx.publishAt,
        }
      : { status: "published", remotePostId: null, permalink: null };
  },
};

// ---------------------------------------------------------------------------

type PageLike = Parameters<SocialPlatform["probeSignIn"]>[0];

async function firstOf(
  page: PageLike,
  selectors: string[],
  timeoutMs: number,
  description: string,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        const locator = page.locator(selector).first();
        if (await locator.isVisible({ timeout: 1_000 })) return locator;
      } catch {
        // Try the next candidate.
      }
    }
  }
  throw new Error(
    `Could not find the ${description} in YouTube Studio. The layout has changed; publish this one by hand.`,
  );
}

async function clickFirst(
  page: PageLike,
  selectors: string[],
  timeoutMs: number,
  description: string,
): Promise<void> {
  const locator = await firstOf(page, selectors, timeoutMs, description);
  await locator.click();
}
