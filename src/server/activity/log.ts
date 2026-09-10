import { prisma } from "@/server/db";
import { ActorType } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";

/**
 * The single writer for the activity stream. Every meaningful state change goes
 * through here, which is what makes the audit trail complete rather than
 * best-effort.
 */

export type ActivityInput = {
  action: string;
  message: string;
  projectId?: string | null;
  userId?: string | null;
  actorType?: ActorType;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue;
};

export async function recordActivity(input: ActivityInput): Promise<void> {
  await prisma.activityLog.create({
    data: {
      action: input.action,
      message: input.message,
      projectId: input.projectId ?? null,
      userId: input.userId ?? null,
      actorType: input.actorType ?? (input.userId ? ActorType.USER : ActorType.SYSTEM),
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      metadata: input.metadata ?? {},
    },
  });
}

/**
 * Logging must never break the operation it describes. Used by the worker, where
 * a failed insert should not fail a publish that already succeeded.
 */
export async function recordActivitySafe(input: ActivityInput): Promise<void> {
  try {
    await recordActivity(input);
  } catch (error) {
    console.error("[activity] failed to record", input.action, error);
  }
}

export const activityActions = {
  assetUploaded: "asset.uploaded",
  assetAnalyzed: "asset.analyzed",
  assetAnalysisFailed: "asset.analysis_failed",
  variantCreated: "variant.created",
  variantUpdated: "variant.updated",
  postCreated: "post.created",
  postApproved: "post.approved",
  postRejected: "post.rejected",
  postScheduled: "post.scheduled",
  postUnscheduled: "post.unscheduled",
  publishQueued: "publish.queued",
  publishStarted: "publish.started",
  publishSucceeded: "publish.succeeded",
  publishFailed: "publish.failed",
  publishRetried: "publish.retried",
  accountConnected: "account.connected",
  accountDisconnected: "account.disconnected",
  accountVerified: "account.verified",
  analyticsSynced: "analytics.synced",
  recommendationsUpdated: "recommendations.updated",
  trendsDiscovered: "trends.discovered",
  experimentConcluded: "experiment.concluded",
  userSignedIn: "auth.signed_in",
  userSignedOut: "auth.signed_out",
} as const;
