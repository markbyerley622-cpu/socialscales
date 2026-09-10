import { prisma } from "@/server/db";
import { getAdapter } from "@/server/platforms/registry";
import type { ValidationIssue } from "@/server/platforms/types";
import { activityActions, recordActivity } from "@/server/activity/log";
import { enqueuePublish, cancelPublish } from "./publish-service";
import {
  ActorType,
  ApprovalState,
  BriefStatus,
  PostPlatformStatus,
  PostStatus,
  PublishPolicy,
} from "@/generated/prisma/enums";

/**
 * The post lifecycle: draft → ready → approved → scheduled → uploading →
 * published. The project's PublishPolicy decides how much of that a human has to
 * confirm, and MANUAL_APPROVAL is the default everywhere.
 */

export type SmartApprovalThresholds = {
  /** Mean of the five scorecard dimensions required to skip human review. */
  minAverageScore: number;
  /** Platform validation must produce no warnings either. */
  requireCleanValidation: boolean;
};

export const SMART_APPROVAL: SmartApprovalThresholds = {
  minAverageScore: 8,
  requireCleanValidation: true,
};

export type CreatePostInput = {
  projectId: string;
  assetId: string;
  variantId: string;
  socialAccountIds: string[];
  scheduledFor: Date | null;
  userId: string | null;
  experimentId?: string | null;
};

export type CreatePostResult = {
  postId: string;
  status: PostStatus;
  approvalState: ApprovalState;
  validation: Record<string, ValidationIssue[]>;
  autoApproved: boolean;
};

export async function createPost(
  input: CreatePostInput,
): Promise<CreatePostResult> {
  if (input.socialAccountIds.length === 0) {
    throw new Error("A post needs at least one destination account.");
  }

  const [project, asset, variant, accounts] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: input.projectId } }),
    prisma.contentAsset.findUniqueOrThrow({ where: { id: input.assetId } }),
    prisma.contentVariant.findUniqueOrThrow({ where: { id: input.variantId } }),
    prisma.socialAccount.findMany({
      where: { id: { in: input.socialAccountIds }, projectId: input.projectId },
    }),
  ]);

  if (accounts.length !== input.socialAccountIds.length) {
    throw new Error(
      "One or more destination accounts do not belong to this project.",
    );
  }
  if (asset.projectId !== input.projectId) {
    throw new Error("That asset does not belong to this project.");
  }

  // The variant normally belongs to the asset being published. A rendered cut
  // is the exception: it is a *derived* asset, and the variant whose treatment
  // produced it still belongs to the source footage. Allowing that pairing is
  // the one integration point rendering needed — the alternative would be
  // duplicating the variant onto the cut, which would sever the link between
  // the copy that was written and the analytics it eventually earns.
  if (variant.assetId !== input.assetId) {
    const renderedFromVariant = await prisma.renderJob.findFirst({
      where: { outputAssetId: input.assetId, variantId: input.variantId },
      select: { id: true },
    });
    if (!renderedFromVariant) {
      throw new Error(
        "That variant belongs to a different asset, and this asset was not rendered from it.",
      );
    }
  }

  // Per-platform media validation happens here, before anything is queued, so
  // problems surface at approval time rather than mid-publish.
  const validation: Record<string, ValidationIssue[]> = {};
  for (const account of accounts) {
    const verdict = getAdapter(account.platform).validateMedia({
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      durationSeconds: asset.durationSeconds,
      aspectRatio: asset.aspectRatio,
    });
    validation[account.platform] = verdict.issues;
    if (!verdict.ok) {
      throw new Error(
        `${getAdapter(account.platform).label} will not accept this media: ` +
          verdict.issues
            .filter((issue) => issue.severity === "error")
            .map((issue) => issue.message)
            .join(" "),
      );
    }
  }

  const decision = decideApproval({
    policy: project.publishPolicy,
    scorecard: variant.scorecard,
    issues: Object.values(validation).flat(),
  });

  const post = await prisma.post.create({
    data: {
      projectId: input.projectId,
      assetId: input.assetId,
      variantId: input.variantId,
      experimentId: input.experimentId ?? null,
      scheduledFor: input.scheduledFor,
      status: decision.status,
      approvalState: decision.approvalState,
      approvedById: decision.autoApproved ? null : null,
      approvedAt: decision.autoApproved ? new Date() : null,
      targets: {
        create: accounts.map((account) => ({
          socialAccountId: account.id,
          platform: account.platform,
          status: PostPlatformStatus.PENDING,
        })),
      },
    },
  });

  // Close the loop back to the plan. The asset already knows which brief it was
  // made for, so no guess is involved — the brief is only marked fulfilled when
  // something explicitly claimed it.
  if (asset.briefId) {
    await prisma.contentBrief.update({
      where: { id: asset.briefId },
      data: { postId: post.id, status: BriefStatus.FULFILLED },
    });
  }

  await recordActivity({
    action: activityActions.postCreated,
    message: `Created post "${variant.hook}" for ${accounts.map((a) => a.platform).join(", ")}`,
    projectId: input.projectId,
    userId: input.userId,
    actorType: input.userId ? ActorType.USER : ActorType.SYSTEM,
    entityType: "Post",
    entityId: post.id,
    metadata: {
      policy: project.publishPolicy,
      autoApproved: decision.autoApproved,
      scheduledFor: input.scheduledFor?.toISOString() ?? null,
    },
  });

  // Auto-approved posts with a time go straight into the queue.
  if (decision.autoApproved && input.scheduledFor) {
    await schedulePost({
      postId: post.id,
      scheduledFor: input.scheduledFor,
      userId: input.userId,
    });
  }

  return {
    postId: post.id,
    status: decision.status,
    approvalState: decision.approvalState,
    validation,
    autoApproved: decision.autoApproved,
  };
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

type ApprovalDecision = {
  status: PostStatus;
  approvalState: ApprovalState;
  autoApproved: boolean;
  reason: string;
};

/**
 * Pure decision function, kept separate so the policy is directly testable.
 *
 * SMART_APPROVAL only skips a human when the copy scores well AND every platform
 * accepted the media without warnings. Anything less goes to a person.
 */
export function decideApproval(input: {
  policy: PublishPolicy;
  scorecard: unknown;
  issues: ValidationIssue[];
}): ApprovalDecision {
  if (input.policy === PublishPolicy.AUTO_PUBLISH) {
    return {
      status: PostStatus.APPROVED,
      approvalState: ApprovalState.NOT_REQUIRED,
      autoApproved: true,
      reason: "Project policy is AUTO_PUBLISH.",
    };
  }

  if (input.policy === PublishPolicy.SMART_APPROVAL) {
    const average = averageScore(input.scorecard);
    const hasWarnings = input.issues.some((issue) => issue.severity === "warning");

    if (average === null) {
      return {
        status: PostStatus.READY,
        approvalState: ApprovalState.PENDING,
        autoApproved: false,
        reason: "No scorecard available, so a human decides.",
      };
    }
    if (SMART_APPROVAL.requireCleanValidation && hasWarnings) {
      return {
        status: PostStatus.READY,
        approvalState: ApprovalState.PENDING,
        autoApproved: false,
        reason: "Platform validation produced warnings.",
      };
    }
    if (average >= SMART_APPROVAL.minAverageScore) {
      return {
        status: PostStatus.APPROVED,
        approvalState: ApprovalState.NOT_REQUIRED,
        autoApproved: true,
        reason: `Scorecard average ${average.toFixed(1)} met the ${SMART_APPROVAL.minAverageScore} threshold.`,
      };
    }
    return {
      status: PostStatus.READY,
      approvalState: ApprovalState.PENDING,
      autoApproved: false,
      reason: `Scorecard average ${average.toFixed(1)} is below the ${SMART_APPROVAL.minAverageScore} threshold.`,
    };
  }

  return {
    status: PostStatus.READY,
    approvalState: ApprovalState.PENDING,
    autoApproved: false,
    reason: "Project policy is MANUAL_APPROVAL.",
  };
}

export function averageScore(scorecard: unknown): number | null {
  if (!scorecard || typeof scorecard !== "object") return null;
  const record = scorecard as Record<string, unknown>;
  const keys = ["hook", "clarity", "curiosity", "cta", "trendRelevance"];
  const values = keys
    .map((key) => record[key])
    .filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function approvePost(input: {
  postId: string;
  userId: string;
  scheduledFor?: Date | null;
}): Promise<void> {
  const post = await prisma.post.findUniqueOrThrow({
    where: { id: input.postId },
    include: { variant: true },
  });

  if (post.approvalState === ApprovalState.APPROVED) return;

  const scheduledFor = input.scheduledFor ?? post.scheduledFor;

  await prisma.post.update({
    where: { id: input.postId },
    data: {
      approvalState: ApprovalState.APPROVED,
      approvedById: input.userId,
      approvedAt: new Date(),
      rejectedReason: null,
      status: PostStatus.APPROVED,
      scheduledFor,
    },
  });

  await recordActivity({
    action: activityActions.postApproved,
    message: `Approved "${post.variant.hook}"`,
    projectId: post.projectId,
    userId: input.userId,
    entityType: "Post",
    entityId: post.id,
  });

  if (scheduledFor) {
    await schedulePost({
      postId: post.id,
      scheduledFor,
      userId: input.userId,
    });
  }
}

export async function rejectPost(input: {
  postId: string;
  userId: string;
  reason: string;
}): Promise<void> {
  const post = await prisma.post.findUniqueOrThrow({
    where: { id: input.postId },
    include: { variant: true },
  });

  await cancelPublish(post.id);

  await prisma.post.update({
    where: { id: input.postId },
    data: {
      approvalState: ApprovalState.REJECTED,
      rejectedReason: input.reason,
      status: PostStatus.DRAFT,
      scheduledFor: null,
    },
  });

  await recordActivity({
    action: activityActions.postRejected,
    message: `Rejected "${post.variant.hook}": ${input.reason}`,
    projectId: post.projectId,
    userId: input.userId,
    entityType: "Post",
    entityId: post.id,
  });
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export class NotApprovedError extends Error {
  constructor() {
    super("This post has not been approved, so it cannot be scheduled.");
    this.name = "NotApprovedError";
  }
}

/**
 * Puts an approved post into the queue. Refuses anything not approved — the
 * approval gate lives here rather than in the UI, because server actions are
 * callable directly.
 */
export async function schedulePost(input: {
  postId: string;
  scheduledFor: Date;
  userId: string | null;
}): Promise<void> {
  const post = await prisma.post.findUniqueOrThrow({
    where: { id: input.postId },
    include: { variant: true, targets: true },
  });

  const approved =
    post.approvalState === ApprovalState.APPROVED ||
    post.approvalState === ApprovalState.NOT_REQUIRED;
  if (!approved) throw new NotApprovedError();

  await prisma.post.update({
    where: { id: post.id },
    data: { scheduledFor: input.scheduledFor, status: PostStatus.SCHEDULED },
  });

  await enqueuePublish({ postId: post.id, runAt: input.scheduledFor });

  await recordActivity({
    action: activityActions.postScheduled,
    message: `Scheduled "${post.variant.hook}" for ${input.scheduledFor.toISOString()}`,
    projectId: post.projectId,
    userId: input.userId,
    entityType: "Post",
    entityId: post.id,
    metadata: { scheduledFor: input.scheduledFor.toISOString() },
  });
}

export async function unschedulePost(input: {
  postId: string;
  userId: string | null;
}): Promise<void> {
  const post = await prisma.post.findUniqueOrThrow({
    where: { id: input.postId },
    include: { variant: true },
  });

  await cancelPublish(post.id);

  await prisma.post.update({
    where: { id: post.id },
    data: { scheduledFor: null, status: PostStatus.APPROVED },
  });

  await recordActivity({
    action: activityActions.postUnscheduled,
    message: `Removed "${post.variant.hook}" from the schedule`,
    projectId: post.projectId,
    userId: input.userId,
    entityType: "Post",
    entityId: post.id,
  });
}
