import { createHash } from "node:crypto";
import {
  AdapterFailure,
  type PublishOutcome,
  type StepLogger,
} from "@/server/platforms/types";
import { FailureCategory } from "@/generated/prisma/enums";
import type { Platform } from "@/generated/prisma/enums";
import { env } from "@/env";

/**
 * Offline publish simulator.
 *
 * With ENABLE_LIVE_PUBLISHING unset, the worker runs this instead of a real
 * browser. It walks the same step sequence, writes the same log lines and
 * returns the same `PublishOutcome` shape, so the whole pipeline — queue,
 * retries, idempotency, status transitions, activity log, analytics — is
 * exercisable end to end without touching a live account.
 *
 * Outcomes are deterministic per post so a retry of the same post behaves the
 * same way, and the test suite does not flake.
 */

const STEPS = [
  "Browser launched",
  "Restored stored session",
  "Account authenticated",
  "Composer opened",
  "Media uploaded",
  "Caption entered",
  "Metadata applied",
];

export type SimulationInput = {
  platform: Platform;
  postPlatformId: string;
  caption: string;
  publishAt: Date | null;
  log: StepLogger;
  /** Attempt number, so a retried job can be made to succeed. */
  attemptNo: number;
};

/**
 * Deterministic 0..1 value derived from the id. Combined with
 * SIMULATED_FAILURE_RATE this decides whether a first attempt fails, so the
 * retry path and the failure UI are reachable in a demo install.
 */
function jitter(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

export async function simulatePublish(
  input: SimulationInput,
): Promise<PublishOutcome> {
  await input.log("Publish simulator active (ENABLE_LIVE_PUBLISHING is off)", {
    platform: input.platform,
  });

  for (const step of STEPS) {
    await input.log(step);
    // Small real delay so the step timestamps in the UI are distinguishable.
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  const roll = jitter(`${input.postPlatformId}:${input.attemptNo}`);
  if (input.attemptNo === 1 && roll < env.simulatedFailureRate) {
    await input.log("Simulated transient failure: composer did not confirm in time");
    // Classified like a real adapter would classify it. The simulator stands in
    // for an adapter, so it owes the runner the same typed failure rather than a
    // bare Error the runner has to guess about.
    throw new AdapterFailure(
      "Simulated transient publish failure (composer confirmation timed out). This is the retry path, not a real platform error.",
      FailureCategory.TRANSIENT,
      "SUBMITTED",
    );
  }

  const remotePostId = `sim_${createHash("sha1")
    .update(input.postPlatformId)
    .digest("hex")
    .slice(0, 16)}`;

  if (input.publishAt && input.publishAt.getTime() > Date.now()) {
    await input.log("Simulated native schedule accepted", {
      publishAt: input.publishAt.toISOString(),
    });
    return {
      status: "scheduled",
      remotePostId,
      permalink: null,
      platformAccountId: null,
      scheduledFor: input.publishAt,
      // The simulator never produces platform evidence, because there is no
      // platform. The runner records adapterMode SIMULATED alongside this.
      verification: null,
    };
  }

  await input.log("Publish confirmed", { remotePostId });
  return {
    status: "published",
    remotePostId,
    permalink: `https://example.invalid/simulated/${remotePostId}`,
    platformAccountId: null,
    verification: null,
  };
}

/**
 * Deterministic metric generator for simulated posts, used by the analytics
 * sync job so the dashboard has something real to aggregate. Values grow with
 * the age of the post rather than being random per call.
 */
export function simulateMetrics(input: {
  postPlatformId: string;
  hook: string;
  publishedAt: Date;
  windowLabel: string;
  followerBase: number;
}): {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  profileVisits: number;
  linkClicks: number;
  conversions: number;
  followerDelta: number;
  watchTimeSeconds: number;
  completionRate: number;
} {
  const windowMultiplier =
    { "1h": 0.08, "24h": 0.35, "7d": 0.85, "30d": 1 }[input.windowLabel] ?? 1;

  const seed = jitter(`${input.postPlatformId}:${input.windowLabel}`);
  // Hook length and question marks shift the outcome a little, so the learning
  // engine has a real signal to find rather than pure noise.
  const hookBonus =
    (input.hook.includes("?") ? 0.25 : 0) +
    (/\d/.test(input.hook) ? 0.2 : 0) +
    (input.hook.length < 60 ? 0.15 : 0);

  const base = input.followerBase * (0.4 + seed * 2.2) * (1 + hookBonus);
  const views = Math.round(base * windowMultiplier);
  const engagementRate = 0.03 + seed * 0.05 + hookBonus * 0.02;

  const likes = Math.round(views * engagementRate);
  const comments = Math.round(likes * (0.05 + seed * 0.06));
  const shares = Math.round(likes * (0.1 + seed * 0.12));
  const saves = Math.round(likes * (0.08 + seed * 0.1));
  const profileVisits = Math.round(views * (0.012 + seed * 0.02));
  const linkClicks = Math.round(profileVisits * (0.1 + seed * 0.2));
  const conversions = Math.round(linkClicks * (0.03 + seed * 0.07));
  const completionRate = Math.min(0.95, 0.35 + seed * 0.4 + hookBonus * 0.1);

  return {
    views,
    likes,
    comments,
    shares,
    saves,
    profileVisits,
    linkClicks,
    conversions,
    followerDelta: Math.round(profileVisits * (0.05 + seed * 0.1)),
    watchTimeSeconds: Math.round(views * completionRate * 12) / 1,
    completionRate: Math.round(completionRate * 1000) / 1000,
  };
}
