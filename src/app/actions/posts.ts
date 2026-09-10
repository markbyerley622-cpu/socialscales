"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/server/db";
import { requireUser } from "@/server/auth/session";
import {
  attachAssetToBrief,
  detachAssetFromBrief,
} from "@/server/content-director";
import { writeTreatment } from "@/server/services/treatment-service";
import {
  cancelRender,
  enqueueRender,
  RenderError,
} from "@/server/rendering";
import {
  approvePost,
  createPost,
  rejectPost,
  schedulePost,
  unschedulePost,
} from "@/server/services/post-service";
import {
  analyzeAsset,
  createVariant,
  updateVariant,
} from "@/server/services/content-service";

/**
 * Post and content mutations.
 *
 * Every action re-checks the session: a server action is a POST endpoint, so the
 * page-level guard is not sufficient. Each returns a plain result object rather
 * than throwing, so the UI can show the failure in place.
 */

export type ActionResult = { ok: boolean; message: string };

function fail(error: unknown, fallback: string): ActionResult {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[action] ${fallback}:`, error);
  return { ok: false, message: message || fallback };
}

/** Pages that show post state and need refreshing after any change. */
function revalidatePostViews(): void {
  for (const path of ["/", "/approvals", "/calendar", "/queue", "/content", "/activity"]) {
    revalidatePath(path);
  }
}

// ---------------------------------------------------------------------------

const createPostSchema = z.object({
  projectId: z.string().min(1),
  assetId: z.string().min(1),
  variantId: z.string().min(1),
  socialAccountIds: z.array(z.string().min(1)).min(1),
  // Already normalised to an ISO string (or null) by parseLocalDateTime below.
  scheduledFor: z.string().nullable(),
});

export async function createPostAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const raw = {
      projectId: String(formData.get("projectId") ?? ""),
      assetId: String(formData.get("assetId") ?? ""),
      variantId: String(formData.get("variantId") ?? ""),
      socialAccountIds: formData.getAll("socialAccountIds").map(String),
      scheduledFor: parseLocalDateTime(formData.get("scheduledFor")),
    };

    const parsed = createPostSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        message:
          "Pick a copy variant, at least one destination account, and a valid time.",
      };
    }

    const result = await createPost({
      projectId: parsed.data.projectId,
      assetId: parsed.data.assetId,
      variantId: parsed.data.variantId,
      socialAccountIds: parsed.data.socialAccountIds,
      scheduledFor: parsed.data.scheduledFor
        ? new Date(parsed.data.scheduledFor)
        : null,
      userId: user.id,
    });

    revalidatePostViews();

    const warnings = Object.values(result.validation)
      .flat()
      .filter((issue) => issue.severity === "warning");

    return {
      ok: true,
      message: result.autoApproved
        ? `Created and auto-approved under this project's policy.${warningSuffix(warnings.length)}`
        : `Created and sent for approval.${warningSuffix(warnings.length)}`,
    };
  } catch (error) {
    return fail(error, "Could not create the post");
  }
}

function warningSuffix(count: number): string {
  return count > 0
    ? ` ${count} platform warning${count === 1 ? "" : "s"} — see the post detail.`
    : "";
}

// ---------------------------------------------------------------------------

export async function approvePostAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const postId = String(formData.get("postId") ?? "");
    if (!postId) return { ok: false, message: "Missing post." };

    const scheduledFor = parseLocalDateTime(formData.get("scheduledFor"));

    await approvePost({
      postId,
      userId: user.id,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined,
    });

    revalidatePostViews();
    return {
      ok: true,
      message: scheduledFor
        ? "Approved and scheduled. The worker will publish it at that time."
        : "Approved. Give it a time to queue it for publishing.",
    };
  } catch (error) {
    return fail(error, "Could not approve the post");
  }
}

export async function rejectPostAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const postId = String(formData.get("postId") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (!postId) return { ok: false, message: "Missing post." };
    if (reason.length < 3) {
      return { ok: false, message: "Give a reason so the rejection is useful later." };
    }

    await rejectPost({ postId, userId: user.id, reason });
    revalidatePostViews();
    return { ok: true, message: "Rejected, and any queued jobs were cancelled." };
  } catch (error) {
    return fail(error, "Could not reject the post");
  }
}

export async function schedulePostAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const postId = String(formData.get("postId") ?? "");
    const scheduledFor = parseLocalDateTime(formData.get("scheduledFor"));
    if (!postId || !scheduledFor) {
      return { ok: false, message: "A post and a time are both required." };
    }

    await schedulePost({
      postId,
      scheduledFor: new Date(scheduledFor),
      userId: user.id,
    });
    revalidatePostViews();
    return { ok: true, message: "Scheduled." };
  } catch (error) {
    return fail(error, "Could not schedule the post");
  }
}

export async function unschedulePostAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const postId = String(formData.get("postId") ?? "");
    if (!postId) return { ok: false, message: "Missing post." };

    await unschedulePost({ postId, userId: user.id });
    revalidatePostViews();
    return { ok: true, message: "Removed from the schedule." };
  } catch (error) {
    return fail(error, "Could not unschedule the post");
  }
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export async function analyzeAssetAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const assetId = String(formData.get("assetId") ?? "");
    if (!assetId) return { ok: false, message: "Missing asset." };

    const result = await analyzeAsset({ assetId, userId: user.id, variantCount: 3 });
    revalidatePath("/ops/content");
    revalidatePath(`/ops/content/${assetId}`);
    return {
      ok: true,
      message: `Analysed as ${result.format.toLowerCase().replace(/_/g, " ")} with ${result.variantIds.length} new copy variants.`,
    };
  } catch (error) {
    return fail(error, "Analysis failed");
  }
}

const variantSchema = z.object({
  label: z.string().trim().min(1).max(80),
  hook: z.string().trim().min(3).max(300),
  caption: z.string().trim().min(3).max(3000),
  cta: z.string().trim().max(200),
  hashtags: z.string().max(600),
});

function parseHashtags(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .slice(0, 20);
}

export async function createVariantAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const assetId = String(formData.get("assetId") ?? "");
    const parsed = variantSchema.safeParse({
      label: formData.get("label"),
      hook: formData.get("hook"),
      caption: formData.get("caption"),
      cta: formData.get("cta") ?? "",
      hashtags: formData.get("hashtags") ?? "",
    });
    if (!assetId || !parsed.success) {
      return { ok: false, message: "A label, hook and caption are all required." };
    }

    await createVariant({
      assetId,
      userId: user.id,
      label: parsed.data.label,
      hook: parsed.data.hook,
      caption: parsed.data.caption,
      cta: parsed.data.cta,
      hashtags: parseHashtags(parsed.data.hashtags),
    });

    revalidatePath(`/ops/content/${assetId}`);
    return { ok: true, message: "Variant added and scored." };
  } catch (error) {
    return fail(error, "Could not add the variant");
  }
}

export async function updateVariantAction(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const variantId = String(formData.get("variantId") ?? "");
    const assetId = String(formData.get("assetId") ?? "");
    const parsed = variantSchema.safeParse({
      label: formData.get("label") ?? "edited",
      hook: formData.get("hook"),
      caption: formData.get("caption"),
      cta: formData.get("cta") ?? "",
      hashtags: formData.get("hashtags") ?? "",
    });
    if (!variantId || !parsed.success) {
      return { ok: false, message: "A hook and caption are both required." };
    }

    await updateVariant({
      variantId,
      userId: user.id,
      hook: parsed.data.hook,
      caption: parsed.data.caption,
      cta: parsed.data.cta,
      hashtags: parseHashtags(parsed.data.hashtags),
    });

    if (assetId) revalidatePath(`/ops/content/${assetId}`);
    return { ok: true, message: "Saved and re-scored." };
  } catch (error) {
    return fail(error, "Could not save the variant");
  }
}

// ---------------------------------------------------------------------------

/**
 * `datetime-local` inputs submit "2026-09-11T19:30" with no zone, which the
 * browser means as local time. Appending seconds and letting Date interpret it
 * locally preserves that intent; an empty field means "no time yet".
 */
function parseLocalDateTime(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export async function attachAssetToBriefAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireUser();
    const assetId = String(formData.get("assetId") ?? "");
    const briefId = String(formData.get("briefId") ?? "");
    if (!assetId) return { ok: false, message: "Missing asset." };

    if (!briefId) {
      await detachAssetFromBrief(assetId);
      revalidatePath(`/ops/content/${assetId}`);
      revalidatePath("/ops/plan");
      return { ok: true, message: "Unlinked from its brief." };
    }

    await attachAssetToBrief({ assetId, briefId });
    revalidatePath(`/ops/content/${assetId}`);
    revalidatePath("/ops/plan");
    return {
      ok: true,
      message: "Linked. The brief now shows as in production, and publishing it will fulfil the brief.",
    };
  } catch (error) {
    return fail(error, "Could not link the asset to that brief");
  }
}

export async function writeTreatmentAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const variantId = String(formData.get("variantId") ?? "");
    if (!variantId) return { ok: false, message: "Missing variant." };

    const variant = await prisma.contentVariant.findUniqueOrThrow({
      where: { id: variantId },
      select: { assetId: true },
    });
    const result = await writeTreatment({ variantId });
    revalidatePath(`/ops/content/${variant.assetId}`);

    if (!result.ok) {
      return { ok: false, message: `Treatment rejected (${result.errorKind}): ${result.reason}` };
    }
    return {
      ok: true,
      message: result.deliversKeyMessage
        ? `${result.beats} beats. It delivers the brief's key message.`
        : `${result.beats} beats. Heads up — it does not deliver the brief's key message: ${result.keyMessageNote}`,
    };
  } catch (error) {
    return fail(error, "Could not write a treatment");
  }
}

export async function renderVariantAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const variantId = String(formData.get("variantId") ?? "");
    if (!variantId) return { ok: false, message: "Missing variant." };
    const force = formData.get("force") === "1";

    const variant = await prisma.contentVariant.findUniqueOrThrow({
      where: { id: variantId },
      select: { assetId: true },
    });

    const result = await enqueueRender({ variantId, force });
    revalidatePath(`/ops/content/${variant.assetId}`);
    revalidatePath("/ops/renders");

    if (!result.queued && result.status !== "SUCCEEDED") {
      // The row exists either way, so the sweeper will pick it up once Redis is
      // back. Saying "queued" here would be a lie the operator acts on.
      return {
        ok: false,
        message: `The render is recorded but could not reach the queue: ${result.queueError ?? "unknown reason"}. It will start when the queue is reachable.`,
      };
    }
    if (result.status === "SUCCEEDED") {
      return { ok: true, message: "This exact cut has already been rendered." };
    }
    return {
      ok: true,
      message: result.reused
        ? "This cut is already rendering."
        : "Queued. The worker picks it up next.",
    };
  } catch (error) {
    if (error instanceof RenderError) {
      return { ok: false, message: `Cannot render: ${error.message}` };
    }
    return fail(error, "Could not queue a render");
  }
}

export async function cancelRenderAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireUser();
    const renderJobId = String(formData.get("renderJobId") ?? "");
    if (!renderJobId) return { ok: false, message: "Missing render job." };
    await cancelRender(renderJobId);
    revalidatePath("/ops/renders");
    return { ok: true, message: "Cancelled. A running encode stops at its next clip." };
  } catch (error) {
    return fail(error, "Could not cancel the render");
  }
}
