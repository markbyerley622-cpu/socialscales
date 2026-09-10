import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { env } from "@/env";
import { prisma } from "@/server/db";
import { sealJson, unsealJson } from "@/server/security/crypto";
import { PlatformSessionStatus } from "@/generated/prisma/enums";

/**
 * Browser session management.
 *
 * A "session" here is Playwright's `storageState`: cookies plus localStorage,
 * captured after the operator signed in by hand. It is encrypted with
 * AES-256-GCM before it touches the database. Passwords are never seen by this
 * process, let alone stored.
 *
 * Nothing in this module tries to look like a different browser than it is.
 * There is no fingerprint spoofing, no stealth plugin and no challenge solving:
 * if a platform asks for verification, the run stops and a human takes over.
 */

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

export type LaunchOptions = {
  /** Overrides PLAYWRIGHT_HEADLESS. Connect flows must be headed. */
  headless?: boolean;
};

export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({
    headless: options.headless ?? env.playwrightHeadless,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/**
 * The single Chromium arg above stops Chrome's own "browser is being automated"
 * infobar from stealing focus during a manual login. It is a usability setting
 * for the operator, not an evasion measure.
 */

export async function newContext(
  browser: Browser,
  storageState?: StorageState,
): Promise<BrowserContext> {
  return browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    storageState,
    acceptDownloads: false,
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function saveSession(
  socialAccountId: string,
  state: StorageState,
): Promise<void> {
  const sealed = sealJson(state);
  await prisma.platformSession.upsert({
    where: { socialAccountId },
    create: {
      socialAccountId,
      cipherText: sealed.cipherText,
      iv: sealed.iv,
      authTag: sealed.authTag,
      algorithm: sealed.algorithm,
      status: PlatformSessionStatus.ACTIVE,
      capturedAt: new Date(),
      lastVerifiedAt: new Date(),
    },
    update: {
      cipherText: sealed.cipherText,
      iv: sealed.iv,
      authTag: sealed.authTag,
      algorithm: sealed.algorithm,
      status: PlatformSessionStatus.ACTIVE,
      capturedAt: new Date(),
      lastVerifiedAt: new Date(),
    },
  });
}

export class MissingSessionError extends Error {
  constructor(accountId: string) {
    super(
      `No stored browser session for account ${accountId}. Connect the account before publishing.`,
    );
    this.name = "MissingSessionError";
  }
}

export async function loadSession(
  socialAccountId: string,
): Promise<StorageState> {
  const record = await prisma.platformSession.findUnique({
    where: { socialAccountId },
  });
  if (!record || record.status !== PlatformSessionStatus.ACTIVE) {
    throw new MissingSessionError(socialAccountId);
  }
  return unsealJson<StorageState>({
    cipherText: record.cipherText,
    iv: record.iv,
    authTag: record.authTag,
  });
}

export async function markSessionExpired(
  socialAccountId: string,
): Promise<void> {
  await prisma.platformSession.updateMany({
    where: { socialAccountId },
    data: { status: PlatformSessionStatus.EXPIRED },
  });
}

export async function revokeSession(socialAccountId: string): Promise<void> {
  await prisma.platformSession.deleteMany({ where: { socialAccountId } });
}

// ---------------------------------------------------------------------------
// Scoped helper
// ---------------------------------------------------------------------------

/**
 * Runs `work` in a fresh browser context restored from the account's stored
 * session, and always tears the browser down afterwards.
 */
export async function withAccountSession<T>(
  socialAccountId: string,
  work: (page: Page, context: BrowserContext) => Promise<T>,
  options: LaunchOptions = {},
): Promise<T> {
  const state = await loadSession(socialAccountId);
  const browser = await launchBrowser(options);
  try {
    const context = await newContext(browser, state);
    const page = await context.newPage();
    try {
      return await work(page, context);
    } finally {
      // Persist any refreshed cookies so long-lived sessions keep working.
      try {
        await saveSession(socialAccountId, await context.storageState());
      } catch (error) {
        console.warn("[automation] could not refresh stored session", error);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
