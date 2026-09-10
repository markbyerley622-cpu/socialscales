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
 * Instagram adapter — browser-assisted for Reels.
 *
 * The supported path for programmatic Instagram publishing is the Instagram
 * Graph API, which requires a Business/Creator account linked to a Facebook Page
 * plus an approved Meta app. That is the route to switch to once credentials
 * exist: set `publish` to OFFICIAL_API and implement `publishViaGraphApi`.
 *
 * Until then this drives instagram.com's own web composer, which supports Reels
 * but has no native scheduling (scheduling lives in Meta Business Suite), so
 * `nativeSchedule` is UNSUPPORTED and CONTENT OS holds the job itself.
 */

const constraints: MediaConstraints = {
  maxSizeBytes: 1024 * 1024 * 1024,
  minDurationSeconds: 3,
  maxDurationSeconds: 90,
  acceptedMimeTypes: ["video/mp4", "video/quicktime", "image/jpeg", "image/png"],
  preferredAspectRatios: ["9:16", "4:5", "1:1"],
  captionMaxLength: 2200,
  hashtagMaxCount: 10,
};

const SELECTORS = {
  createButton: [
    'svg[aria-label="New post"]',
    'a[href="/create/select/"]',
    'div[role="button"]:has-text("Create")',
  ],
  fileInput: 'input[type="file"]',
  nextButton: ['div[role="button"]:has-text("Next")', 'button:has-text("Next")'],
  captionBox: [
    'div[aria-label="Write a caption..."]',
    'textarea[aria-label="Write a caption..."]',
  ],
  shareButton: [
    'div[role="button"]:has-text("Share")',
    'button:has-text("Share")',
  ],
  profileLink: ['a[href^="/"][role="link"] img[alt*="profile picture"]'],
};

export const instagramAdapter: SocialPlatform = {
  platform: Platform.INSTAGRAM,
  label: "Instagram",
  loginUrl: "https://www.instagram.com/accounts/login/",
  composerUrl: "https://www.instagram.com/",
  sessionProbeUrl: "https://www.instagram.com/",

  capabilities: {
    upload: "BROWSER_ASSISTED",
    publish: "BROWSER_ASSISTED",
    // Web composer has no scheduling; CONTENT OS queues the job instead.
    nativeSchedule: "UNSUPPORTED",
    metrics: "BROWSER_ASSISTED",
    checkStatus: "BROWSER_ASSISTED",
  },

  constraints,

  validateMedia(candidate) {
    return validateAgainstConstraints(candidate, constraints, "Instagram");
  },

  composeCaption(input) {
    return composeStandardCaption(input, constraints);
  },

  async probeSignIn(page): Promise<SignInProbe> {
    await page.goto(this.sessionProbeUrl, { waitUntil: "domcontentloaded" });
    if (page.url().includes("/accounts/login")) {
      return { signedIn: false, handle: null, displayName: null };
    }
    let handle: string | null = null;
    try {
      const alt = await page
        .locator(SELECTORS.profileLink[0])
        .first()
        .getAttribute("alt", { timeout: 3_000 });
      // Alt text reads "<handle>'s profile picture".
      const match = alt?.match(/^(.+?)'s profile picture$/);
      if (match) handle = match[1];
    } catch {
      // Handle stays null; the account row keeps whatever the operator entered.
    }
    return { signedIn: true, handle, displayName: null };
  },

  async publishViaBrowser(ctx): Promise<PublishOutcome> {
    const { page, log } = ctx;

    await log("Opening Instagram", { url: this.composerUrl });
    await page.goto(this.composerUrl, { waitUntil: "domcontentloaded" });

    if (page.url().includes("/accounts/login")) {
      throw new Error(
        "Instagram redirected to login: the stored session is no longer valid. Reconnect the account.",
      );
    }

    await log("Opening the create dialog");
    let opened = false;
    for (const selector of SELECTORS.createButton) {
      try {
        await page.locator(selector).first().click({ timeout: 5_000 });
        opened = true;
        break;
      } catch {
        // Try the next candidate.
      }
    }
    if (!opened) {
      throw new Error(
        "Could not find Instagram's create button. The web composer layout has changed; publish this one by hand.",
      );
    }

    await log("Selecting media file");
    const fileInput = page.locator(SELECTORS.fileInput).first();
    await fileInput.waitFor({ state: "attached", timeout: 30_000 });
    await fileInput.setInputFiles(ctx.mediaPath);

    // Crop step, then edit step.
    for (const step of ["crop", "edit"]) {
      await log(`Advancing past the ${step} step`);
      let advanced = false;
      for (const selector of SELECTORS.nextButton) {
        try {
          await page.locator(selector).first().click({ timeout: 10_000 });
          advanced = true;
          break;
        } catch {
          // Try the next candidate.
        }
      }
      if (!advanced) {
        throw new Error(`Instagram composer did not advance past the ${step} step.`);
      }
    }

    await log("Entering caption");
    let captionEntered = false;
    for (const selector of SELECTORS.captionBox) {
      try {
        const box = page.locator(selector).first();
        await box.click({ timeout: 5_000 });
        await box.pressSequentially(ctx.caption, { delay: 12 });
        captionEntered = true;
        break;
      } catch {
        // Try the next candidate.
      }
    }
    if (!captionEntered) {
      throw new Error("Could not find Instagram's caption field.");
    }

    await log("Sharing post");
    let shared = false;
    for (const selector of SELECTORS.shareButton) {
      try {
        await page.locator(selector).first().click({ timeout: 10_000 });
        shared = true;
        break;
      } catch {
        // Try the next candidate.
      }
    }
    if (!shared) throw new Error("Could not find Instagram's share button.");

    await log("Waiting for share confirmation");
    await page
      .locator('text=/Your (reel|post) has been shared|Post shared/i')
      .first()
      .waitFor({ timeout: 180_000 });

    await log("Instagram confirmed the post was shared");
    return { status: "published", remotePostId: null, permalink: null };
  },
};
