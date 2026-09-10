"use server";

/**
 * Server actions are the only write path from the UI.
 *
 * Each one delegates straight to the configured adapter, so in `mock` mode they
 * mutate the fixture store and in `http` mode they hit the real SMMA backend —
 * with no change to any component that calls them.
 */

import { revalidatePath } from "next/cache";

import { getAdapter, isAdapterError } from "@/lib/social-scales";
import type { RewriteDirective, ScriptPatch } from "@/lib/social-scales/adapter";
import type { BrandProfile, ContentItem, ScriptDraft } from "@/lib/social-scales/contracts";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

async function run<T>(fn: () => Promise<T>, paths: string[] = []): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    for (const path of paths) revalidatePath(path);
    return { ok: true, data };
  } catch (error) {
    if (isAdapterError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: error instanceof Error ? error.message : "Unexpected error." };
  }
}

/* Onboarding --------------------------------------------------------------- */

export async function saveOnboardingDraftAction(draft: Partial<BrandProfile>) {
  return run(() => getAdapter().saveOnboardingDraft(draft));
}

export async function completeOnboardingAction(profile: Partial<BrandProfile>) {
  return run(() => getAdapter().completeOnboarding(profile), ["/dashboard", "/plan"]);
}

/* Plan --------------------------------------------------------------------- */

export async function createPlanAction(clientId?: string) {
  return run(() => getAdapter().createPlan(clientId), ["/plan", "/dashboard"]);
}

export async function approvePlanAction(planId: string) {
  return run(() => getAdapter().approvePlan(planId), ["/plan", "/dashboard"]);
}

/* Ideas + script ----------------------------------------------------------- */

export async function generateIdeasAction(clientId: string, count = 5) {
  return run(() => getAdapter().generateIdeas(clientId, count), ["/studio", "/content"]);
}

export async function createIdeaAction(clientId: string, title: string) {
  return run(() => getAdapter().createContentIdea(clientId, title), ["/studio", "/content"]);
}

export async function updateScriptAction(
  contentItemId: string,
  patch: ScriptPatch,
): Promise<ActionResult<ScriptDraft>> {
  return run(() => getAdapter().updateScript(contentItemId, patch));
}

export async function rewriteScriptAction(
  contentItemId: string,
  directive: RewriteDirective,
): Promise<ActionResult<ScriptDraft>> {
  return run(() => getAdapter().rewriteScript(contentItemId, directive));
}

/* Generation, approval, scheduling ----------------------------------------- */

export async function generateContentAction(contentItemId: string) {
  return run(() => getAdapter().generateContent(contentItemId), ["/studio", "/content", "/dashboard"]);
}

export async function approveContentAction(contentItemId: string): Promise<ActionResult<ContentItem>> {
  return run(() => getAdapter().approveContent(contentItemId), [
    "/studio",
    "/content",
    "/calendar",
    "/dashboard",
  ]);
}

export async function scheduleContentAction(
  contentItemId: string,
  isoDateTime: string,
): Promise<ActionResult<ContentItem>> {
  return run(() => getAdapter().scheduleContent(contentItemId, isoDateTime), [
    "/studio",
    "/content",
    "/calendar",
    "/dashboard",
  ]);
}
