import { createHash } from "node:crypto";
import { z } from "zod";
import type { AIOperation } from "@/generated/prisma/enums";

/**
 * The prompt registry.
 *
 * A prompt is a versioned artefact, not a string literal buried in a service.
 * Registering it here forces three things to exist together: the wording, the
 * output schema it promises, and a deterministic implementation of the same
 * contract. `version` is part of every AIJob record, so changing wording shows
 * up in the history instead of silently rewriting what past jobs "meant".
 *
 * Bump `version` on ANY change to `render`. The registry refuses duplicate
 * name+version pairs so a change without a bump fails at import time.
 */

export type RenderedPrompt = {
  system: string;
  user: string;
};

export type PromptDefinition<TInput, TOutput> = {
  name: string;
  /** Bump on any change to `render`, `schema` or `maxOutputTokens`. */
  version: string;
  operation: AIOperation;
  description: string;
  schema: z.ZodType<TOutput>;
  maxOutputTokens: number;
  render(input: TInput): RenderedPrompt;
  /**
   * The same contract, computed from rules with no model.
   *
   * Every prompt must have one. It is what makes the system usable with no API
   * key, and it is what the deterministic provider serves — through the same
   * validation as model output, so a rule that drifts out of contract fails the
   * same way a bad generation does.
   */
  deterministic(input: TInput): TOutput | Promise<TOutput>;
  /**
   * Checks the schema cannot express, evaluated against the request's own input
   * — a brand's banned phrases, a platform's caption limit, a count that must
   * match what was asked for.
   *
   * Returns a list of problems, empty when the value is acceptable. Failures go
   * through the same repair loop as schema failures, so a violated brand rule is
   * something the model is asked to fix rather than something a human discovers
   * in an approval queue.
   */
  refine?: (value: TOutput, input: TInput) => string[];
};

/** Erased form, so the registry can hold prompts of differing shapes. */
export type AnyPrompt = PromptDefinition<never, unknown>;

const registry = new Map<string, AnyPrompt>();

function key(name: string, version: string): string {
  return `${name}@${version}`;
}

export function registerPrompt<TInput, TOutput>(
  definition: PromptDefinition<TInput, TOutput>,
): PromptDefinition<TInput, TOutput> {
  const id = key(definition.name, definition.version);
  if (registry.has(id)) {
    throw new Error(
      `Prompt ${id} is already registered. Bump the version rather than editing a released prompt in place.`,
    );
  }
  registry.set(id, definition as unknown as AnyPrompt);
  return definition;
}

export function getPrompt(name: string, version: string): AnyPrompt | undefined {
  return registry.get(key(name, version));
}

export function listPrompts(): AnyPrompt[] {
  return [...registry.values()];
}

export function promptsFor(operation: AIOperation): AnyPrompt[] {
  return listPrompts().filter((prompt) => prompt.operation === operation);
}

/**
 * Identity of the exact text sent. Two jobs with the same hash were asked the
 * same question in the same words, whatever the version label says.
 */
export function hashPrompt(rendered: RenderedPrompt): string {
  return createHash("sha256")
    .update(rendered.system)
    .update("\u0000")
    .update(rendered.user)
    .digest("hex")
    .slice(0, 32);
}

/** Stable hash of a typed input, key order independent. */
export function hashInput(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex").slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * JSON Schema for a prompt's output, for providers that enforce shape natively.
 * Zod stays the authority: native enforcement is a convenience, and the runner
 * validates with Zod regardless of what the provider claims to have done.
 */
export function jsonSchemaFor(prompt: { schema: z.ZodType<unknown> }): Record<string, unknown> {
  return z.toJSONSchema(prompt.schema, { io: "output" }) as Record<string, unknown>;
}
