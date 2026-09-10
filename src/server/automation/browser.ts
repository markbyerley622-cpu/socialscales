import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { env } from "@/env";
import { prisma } from "@/server/db";
import { sealJson, unsealJson } from "@/server/security/crypto";
import { STORAGE_ROOT } from "@/server/storage";
import { PlatformSessionStatus } from "@/generated/prisma/enums";

/**
 * Browser session management.
 *
 * Two layers, deliberately:
 *
 *  1. A **dedicated persistent profile** per social account, under the app's own
 *     storage root. Platforms bind sessions to more than cookies — device
 *     storage, IndexedDB, service workers — and a persistent profile keeps all
 *     of it, which is what makes a connection survive restarts in practice.
 *     It is never the operator's personal Chrome profile; `assertDedicatedProfile`
 *     enforces that rather than trusting the caller.
 *
 *  2. An **encrypted storageState in Postgres**, which is the authoritative,
 *     portable copy. It is what lets a worker on a clean machine rebuild a
 *     working profile, and it is the secure mechanism of record — the profile
 *     directory is a local cache that can be deleted at any time.
 *
 * Nothing here tries to look like a different browser than it is. There is no
 * fingerprint spoofing, no stealth plugin and no challenge solving.
 */

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const PROFILE_ROOT = path.join(STORAGE_ROOT, "browser-profiles");

/** Where an account's dedicated automation profile lives. */
export function profileDirFor(socialAccountId: string): string {
  // The id is a cuid, so it is already filesystem-safe; the replace is belt and
  // braces against a future id format.
  return path.join(PROFILE_ROOT, socialAccountId.replace(/[^A-Za-z0-9_-]/g, "_"));
}

/** Storage key form, for the database column. */
export function profileKeyFor(socialAccountId: string): string {
  return `browser-profiles/${socialAccountId}`;
}

/**
 * Refuses to drive anything but our own automation profile.
 *
 * The requirement is that automation never touches the operator's real browser
 * profile. Deriving the path correctly is not the same as guaranteeing it, so
 * this asserts the invariant at the point of use.
 */
export function assertDedicatedProfile(dir: string): void {
  const resolved = path.resolve(dir);
  const root = path.resolve(PROFILE_ROOT);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `Refusing to launch a browser against ${resolved}: automation may only use a ` +
        `dedicated profile under ${root}, never a personal browser profile.`,
    );
  }
  if (/Google[\\/]Chrome[\\/]User Data|Microsoft[\\/]Edge|Mozilla[\\/]Firefox/i.test(resolved)) {
    throw new Error(
      `Refusing to launch a browser against what looks like a real browser profile: ${resolved}`,
    );
  }
}

export type LaunchOptions = {
  /** Overrides PLAYWRIGHT_HEADLESS. Connect flows must be headed. */
  headless?: boolean;
};

/**
 * Opens the account's dedicated persistent context, creating the profile on
 * first use.
 */
export async function openAccountContext(
  socialAccountId: string,
  options: LaunchOptions = {},
): Promise<BrowserContext> {
  const dir = profileDirFor(socialAccountId);
  assertDedicatedProfile(dir);
  await mkdir(dir, { recursive: true });

  return chromium.launchPersistentContext(dir, {
    headless: options.headless ?? env.playwrightHeadless,
    viewport: DEFAULT_VIEWPORT,
    acceptDownloads: false,
    // Suppresses Chrome's "controlled by automated software" infobar, which
    // otherwise steals focus while a person is signing in. A usability setting
    // for the operator, not an evasion measure.
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/** True when the profile directory exists and is not empty. */
export async function profileExists(socialAccountId: string): Promise<boolean> {
  try {
    const entries = await readdir(profileDirFor(socialAccountId));
    return entries.length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function saveSession(
  socialAccountId: string,
  state: StorageState,
): Promise<void> {
  const sealed = sealJson(state);
  const common = {
    cipherText: sealed.cipherText,
    iv: sealed.iv,
    authTag: sealed.authTag,
    algorithm: sealed.algorithm,
    profileKey: profileKeyFor(socialAccountId),
    status: PlatformSessionStatus.ACTIVE,
    capturedAt: new Date(),
    lastVerifiedAt: new Date(),
  };
  await prisma.platformSession.upsert({
    where: { socialAccountId },
    create: { socialAccountId, ...common },
    update: common,
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

export async function hasStoredSession(socialAccountId: string): Promise<boolean> {
  const record = await prisma.platformSession.findUnique({
    where: { socialAccountId },
    select: { status: true },
  });
  return record?.status === PlatformSessionStatus.ACTIVE;
}

export async function markSessionExpired(socialAccountId: string): Promise<void> {
  await prisma.platformSession.updateMany({
    where: { socialAccountId },
    data: { status: PlatformSessionStatus.EXPIRED },
  });
}

export async function revokeSession(socialAccountId: string): Promise<void> {
  await prisma.platformSession.deleteMany({ where: { socialAccountId } });
}

/**
 * Seeds a fresh profile from the encrypted copy in Postgres.
 *
 * Only used when the persistent profile has no cookies for the platform origin —
 * a clean machine, or a deleted profile directory. Restoring on top of a working
 * profile would be a good way to overwrite newer cookies with older ones.
 */
export async function restoreIntoContext(
  context: BrowserContext,
  state: StorageState,
): Promise<void> {
  if (state.cookies?.length) {
    await context.addCookies(state.cookies);
  }
  for (const origin of state.origins ?? []) {
    if (!origin.localStorage?.length) continue;
    // Runs before any page script, so the platform sees its own storage as if
    // it had always been there.
    await context.addInitScript(
      (payload: { origin: string; items: Array<{ name: string; value: string }> }) => {
        if (window.location.origin !== payload.origin) return;
        for (const item of payload.items) {
          try {
            window.localStorage.setItem(item.name, item.value);
          } catch {
            // Storage disabled for this origin; nothing to do.
          }
        }
      },
      { origin: origin.origin, items: origin.localStorage },
    );
  }
}

// ---------------------------------------------------------------------------
// Scoped helper
// ---------------------------------------------------------------------------

/**
 * Runs `work` in the account's dedicated profile, restoring from the encrypted
 * session if the profile is cold, and always writing the refreshed session back.
 */
export async function withAccountSession<T>(
  socialAccountId: string,
  work: (page: Page, context: BrowserContext) => Promise<T>,
  options: LaunchOptions & { originUrl?: string } = {},
): Promise<T> {
  // Requires a stored session: a profile directory alone is not proof that this
  // account was ever connected.
  const state = await loadSession(socialAccountId);

  const context = await openAccountContext(socialAccountId, options);
  try {
    const cold = options.originUrl
      ? (await context.cookies(options.originUrl)).length === 0
      : (await context.cookies()).length === 0;

    if (cold) {
      await restoreIntoContext(context, state);
    }

    const page = context.pages()[0] ?? (await context.newPage());
    try {
      return await work(page, context);
    } finally {
      // Persist refreshed cookies so long-lived sessions keep working.
      try {
        await saveSession(socialAccountId, await context.storageState());
      } catch (error) {
        console.warn("[automation] could not refresh stored session", error);
      }
    }
  } finally {
    await context.close();
  }
}
