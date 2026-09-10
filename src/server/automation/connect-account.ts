import { prisma } from "@/server/db";
import { getAdapter } from "@/server/platforms/registry";
import { recordActivitySafe, activityActions } from "@/server/activity/log";
import { AccountStatus, ActorType } from "@/generated/prisma/enums";
import {
  launchBrowser,
  newContext,
  saveSession,
  withAccountSession,
} from "./browser";

/**
 * Account connection.
 *
 * A headed Chromium window opens on the platform's own login page. The operator
 * types their credentials and completes whatever verification the platform asks
 * for — this process never sees the password and never automates the login form.
 * Once the platform reports a signed-in session, the resulting storageState is
 * encrypted and stored.
 *
 * This runs long (a human is in the loop), so it is invoked as a job rather than
 * inside a request.
 */

export type ConnectResult =
  | { ok: true; handle: string | null; displayName: string | null }
  | { ok: false; reason: string };

const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3_000;

export async function connectAccount(
  socialAccountId: string,
): Promise<ConnectResult> {
  const account = await prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
  });
  if (!account) return { ok: false, reason: "Account no longer exists." };

  const adapter = getAdapter(account.platform);

  // Headed by definition: the operator has to be able to see and use it.
  const browser = await launchBrowser({ headless: false });
  try {
    const context = await newContext(browser);
    const page = await context.newPage();

    await page.goto(adapter.loginUrl, { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let probe = await safeProbe(adapter, page);

    while (!probe.signedIn && Date.now() < deadline) {
      await page.waitForTimeout(POLL_INTERVAL_MS);
      if (page.isClosed()) {
        return {
          ok: false,
          reason: "The browser window was closed before sign-in completed.",
        };
      }
      probe = await safeProbe(adapter, page);
    }

    if (!probe.signedIn) {
      await prisma.socialAccount.update({
        where: { id: socialAccountId },
        data: {
          status: AccountStatus.ERROR,
          lastError: "Sign-in did not complete within 5 minutes.",
          lastCheckedAt: new Date(),
        },
      });
      return { ok: false, reason: "Sign-in did not complete within 5 minutes." };
    }

    await saveSession(socialAccountId, await context.storageState());

    await prisma.socialAccount.update({
      where: { id: socialAccountId },
      data: {
        status: AccountStatus.CONNECTED,
        handle: probe.handle ?? account.handle,
        displayName: probe.displayName ?? account.displayName,
        lastError: null,
        lastCheckedAt: new Date(),
      },
    });

    await recordActivitySafe({
      action: activityActions.accountConnected,
      message: `Connected ${adapter.label} account ${probe.handle ?? account.handle}`,
      projectId: account.projectId,
      actorType: ActorType.WORKER,
      entityType: "SocialAccount",
      entityId: socialAccountId,
    });

    return { ok: true, handle: probe.handle, displayName: probe.displayName };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await prisma.socialAccount.update({
      where: { id: socialAccountId },
      data: {
        status: AccountStatus.ERROR,
        lastError: reason,
        lastCheckedAt: new Date(),
      },
    });
    return { ok: false, reason };
  } finally {
    await browser.close();
  }
}

async function safeProbe(
  adapter: ReturnType<typeof getAdapter>,
  page: Parameters<ReturnType<typeof getAdapter>["probeSignIn"]>[0],
) {
  try {
    return await adapter.probeSignIn(page);
  } catch {
    return { signedIn: false, handle: null, displayName: null };
  }
}

/**
 * Re-checks a stored session without any human involvement. Used by the
 * "Test connection" button and by the diagnostics page.
 */
export async function verifyAccount(
  socialAccountId: string,
): Promise<ConnectResult> {
  const account = await prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
  });
  if (!account) return { ok: false, reason: "Account no longer exists." };

  const adapter = getAdapter(account.platform);

  try {
    const probe = await withAccountSession(
      socialAccountId,
      async (page) => adapter.probeSignIn(page),
      { headless: true },
    );

    await prisma.socialAccount.update({
      where: { id: socialAccountId },
      data: {
        status: probe.signedIn
          ? AccountStatus.CONNECTED
          : AccountStatus.NEEDS_REAUTH,
        handle: probe.handle ?? account.handle,
        lastCheckedAt: new Date(),
        lastError: probe.signedIn ? null : "Stored session is signed out.",
      },
    });

    await recordActivitySafe({
      action: activityActions.accountVerified,
      message: probe.signedIn
        ? `${adapter.label} session verified`
        : `${adapter.label} session is signed out and needs reconnecting`,
      projectId: account.projectId,
      actorType: ActorType.WORKER,
      entityType: "SocialAccount",
      entityId: socialAccountId,
    });

    return probe.signedIn
      ? { ok: true, handle: probe.handle, displayName: probe.displayName }
      : { ok: false, reason: "Stored session is signed out." };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await prisma.socialAccount.update({
      where: { id: socialAccountId },
      data: {
        status: AccountStatus.NEEDS_REAUTH,
        lastError: reason,
        lastCheckedAt: new Date(),
      },
    });
    return { ok: false, reason };
  }
}

export async function disconnectAccount(
  socialAccountId: string,
  userId: string | null,
): Promise<void> {
  const account = await prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
  });
  if (!account) return;

  await prisma.$transaction([
    prisma.platformSession.deleteMany({ where: { socialAccountId } }),
    prisma.socialAccount.update({
      where: { id: socialAccountId },
      data: {
        status: AccountStatus.DISCONNECTED,
        lastError: null,
        lastCheckedAt: new Date(),
      },
    }),
  ]);

  await recordActivitySafe({
    action: activityActions.accountDisconnected,
    message: `Disconnected ${account.platform} account ${account.handle}`,
    projectId: account.projectId,
    userId,
    actorType: userId ? ActorType.USER : ActorType.SYSTEM,
    entityType: "SocialAccount",
    entityId: socialAccountId,
  });
}
