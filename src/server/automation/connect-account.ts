import type { Page } from "playwright";
import { prisma } from "@/server/db";
import { getAdapter } from "@/server/platforms/registry";
import type { SignInProbe, SignInState } from "@/server/platforms/types";
import { recordActivitySafe, activityActions } from "@/server/activity/log";
import { AccountStatus, ActorType } from "@/generated/prisma/enums";
import {
  openAccountContext,
  profileKeyFor,
  saveSession,
  withAccountSession,
} from "./browser";

/**
 * Account connection and verification.
 *
 * A headed Chromium window opens on the platform's own login page, inside this
 * account's dedicated automation profile. The operator types their credentials
 * and completes whatever verification the platform asks for — this process never
 * sees the password and never automates the login form. Once the platform
 * reports a usable signed-in session, the resulting storageState is encrypted
 * and stored.
 *
 * The rule that matters: an account is only marked CONNECTED when a probe
 * returned AUTHENTICATED. The existence of a session blob or a profile directory
 * is never treated as proof of a working connection.
 */

export type ConnectResult =
  | { ok: true; handle: string | null; displayName: string | null; evidence: string }
  | { ok: false; state: SignInState | "ERROR"; reason: string };

const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 3_000;

/** Maps a probe state onto the account status it justifies. */
export function statusForProbe(state: SignInState): AccountStatus {
  switch (state) {
    case "AUTHENTICATED":
      return AccountStatus.CONNECTED;
    case "CHALLENGE":
      return AccountStatus.CHALLENGE;
    case "UNAUTHENTICATED":
      return AccountStatus.NEEDS_REAUTH;
    case "UNKNOWN":
      // Deliberately not CONNECTED: an inconclusive probe is not a working
      // connection, and treating it as one is how a system starts lying.
      return AccountStatus.ERROR;
  }
}

export async function connectAccount(
  socialAccountId: string,
): Promise<ConnectResult> {
  const account = await prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
  });
  if (!account) return { ok: false, state: "ERROR", reason: "Account no longer exists." };

  const adapter = getAdapter(account.platform);

  // Headed by definition: a person has to be able to see and use it.
  const context = await openAccountContext(socialAccountId, { headless: false });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(adapter.loginUrl, { waitUntil: "domcontentloaded" });

    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let probe = await safeProbe(adapter, page);

    while (probe.state !== "AUTHENTICATED" && Date.now() < deadline) {
      await page.waitForTimeout(POLL_INTERVAL_MS);
      if (page.isClosed()) {
        return {
          ok: false,
          state: "UNKNOWN",
          reason: "The browser window was closed before sign-in completed.",
        };
      }
      probe = await safeProbe(adapter, page);
    }

    if (probe.state !== "AUTHENTICATED") {
      const reason =
        probe.state === "CHALLENGE"
          ? "The platform is showing a verification challenge that was not cleared. Complete it in the open window, then connect again."
          : `Sign-in did not complete within 5 minutes (last observed: ${probe.evidence}).`;

      await prisma.socialAccount.update({
        where: { id: socialAccountId },
        data: {
          status: statusForProbe(probe.state),
          lastError: reason,
          lastCheckedAt: new Date(),
        },
      });
      return { ok: false, state: probe.state, reason };
    }

    // Only now, with positive evidence, is anything stored or marked connected.
    await saveSession(socialAccountId, await context.storageState());

    await prisma.socialAccount.update({
      where: { id: socialAccountId },
      data: {
        status: AccountStatus.CONNECTED,
        handle: probe.handle ?? account.handle,
        displayName: probe.displayName ?? account.displayName,
        externalId: probe.platformAccountId ?? account.externalId,
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
      metadata: { evidence: probe.evidence, profile: profileKeyFor(socialAccountId) },
    });

    return {
      ok: true,
      handle: probe.handle,
      displayName: probe.displayName,
      evidence: probe.evidence,
    };
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
    return { ok: false, state: "ERROR", reason };
  } finally {
    await context.close();
  }
}

async function safeProbe(
  adapter: ReturnType<typeof getAdapter>,
  page: Page,
): Promise<SignInProbe> {
  try {
    return await adapter.probeSignIn(page);
  } catch (error) {
    return {
      state: "UNKNOWN",
      handle: null,
      displayName: null,
      platformAccountId: null,
      evidence: `Probe threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Re-checks a stored session with no human involvement. Backs the "Test
 * connection" button, the diagnostics view, and the publish runner's pre-flight.
 */
export async function verifyAccount(
  socialAccountId: string,
): Promise<ConnectResult> {
  const account = await prisma.socialAccount.findUnique({
    where: { id: socialAccountId },
  });
  if (!account) return { ok: false, state: "ERROR", reason: "Account no longer exists." };

  const adapter = getAdapter(account.platform);

  try {
    const probe = await withAccountSession(
      socialAccountId,
      async (page) => adapter.probeSignIn(page),
      { headless: true, originUrl: adapter.sessionProbeUrl },
    );

    const status = statusForProbe(probe.state);

    await prisma.socialAccount.update({
      where: { id: socialAccountId },
      data: {
        status,
        handle: probe.handle ?? account.handle,
        externalId: probe.platformAccountId ?? account.externalId,
        lastCheckedAt: new Date(),
        lastError: probe.state === "AUTHENTICATED" ? null : probe.evidence,
      },
    });

    await recordActivitySafe({
      action: activityActions.accountVerified,
      message:
        probe.state === "AUTHENTICATED"
          ? `${adapter.label} session verified`
          : `${adapter.label} session is ${probe.state.toLowerCase()}`,
      projectId: account.projectId,
      actorType: ActorType.WORKER,
      entityType: "SocialAccount",
      entityId: socialAccountId,
      metadata: { state: probe.state, evidence: probe.evidence },
    });

    return probe.state === "AUTHENTICATED"
      ? {
          ok: true,
          handle: probe.handle,
          displayName: probe.displayName,
          evidence: probe.evidence,
        }
      : { ok: false, state: probe.state, reason: probe.evidence };
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
    return { ok: false, state: "UNKNOWN", reason };
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
    // The encrypted session is deleted outright, not merely marked inactive.
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
