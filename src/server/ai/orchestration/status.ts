import { env } from "@/env";
import { anthropicProvider } from "./providers/anthropic";
import { deterministicProvider } from "./providers/deterministic";
import { listPrompts } from "./registry";

/**
 * What the AI boundary is currently doing, for the diagnostics screen.
 *
 * The point of showing this is that "auto" mode silently changes who answers
 * when a key appears or disappears. An operator reading a suggestion deserves to
 * know whether the system is generating or applying rules, and this is where
 * that is stated once rather than guessed at per screen.
 */

export type AiBoundaryStatus = {
  /** AI_MODEL_PROVIDER: auto | deterministic | anthropic. */
  mode: string;
  /** Who will actually serve the next request. */
  activeProvider: string;
  modelActive: boolean;
  model: string | null;
  /** Present when the model is not active. Never contains the key itself. */
  reason: string | null;
  registeredPrompts: number;
  /** Human-readable summary for a diagnostics row. */
  headline: string;
};

export function aiBoundaryStatus(): AiBoundaryStatus {
  const mode = env.model.provider.toLowerCase();
  const availability = anthropicProvider.availability();
  const prompts = listPrompts().length;

  if (mode === "deterministic") {
    return {
      mode,
      activeProvider: deterministicProvider.name,
      modelActive: false,
      model: null,
      reason: "AI_MODEL_PROVIDER is set to deterministic, so no model is called.",
      registeredPrompts: prompts,
      headline: `Rules only — ${prompts} registered prompts. No model is called and nothing is billed.`,
    };
  }

  if (availability.available) {
    return {
      mode,
      activeProvider: anthropicProvider.name,
      modelActive: true,
      model: anthropicProvider.model,
      reason: null,
      registeredPrompts: prompts,
      headline: `${anthropicProvider.model} is serving ${prompts} registered prompts. Output is validated against each prompt's schema before it is stored.`,
    };
  }

  if (mode === "anthropic") {
    return {
      mode,
      activeProvider: "none",
      modelActive: false,
      model: null,
      reason: availability.reason,
      registeredPrompts: prompts,
      headline: `AI_MODEL_PROVIDER requires the model but it is unavailable: ${availability.reason} Requests will fail rather than fall back.`,
    };
  }

  return {
    mode,
    activeProvider: deterministicProvider.name,
    modelActive: false,
    model: null,
    reason: availability.reason,
    registeredPrompts: prompts,
    headline: `Falling back to rules for all ${prompts} prompts: ${availability.reason} Results are labelled as rule-generated, not model output.`,
  };
}
