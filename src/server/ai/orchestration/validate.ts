import { z } from "zod";

/**
 * Turning provider output into a typed value, or a list of specific complaints.
 *
 * Model output is untrusted input. It is parsed, not evaluated; validated
 * against the prompt's schema, not spot-checked; and when it fails, the failure
 * is turned into instructions precise enough for a repair attempt to act on.
 */

export type ValidationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; problems: string[] };

/**
 * Pulls the JSON object or array out of a response.
 *
 * Providers are asked for bare JSON, and current models generally comply, but a
 * fenced block or a sentence of preamble is a formatting slip rather than a
 * wrong answer — recovering from it is cheaper and more honest than spending a
 * repair round-trip on punctuation.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") throw new SyntaxError("Provider returned no text.");

  const candidates: string[] = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.search(/[[{]/);
  const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? new SyntaxError(`Response was not valid JSON: ${lastError.message}`)
    : new SyntaxError("Response was not valid JSON.");
}

export function validateOutput<T>(
  schema: z.ZodType<T>,
  text: string,
): ValidationOutcome<T> {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (error) {
    return {
      ok: false,
      problems: [error instanceof Error ? error.message : "Response was not valid JSON."],
    };
  }

  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, problems: describeIssues(result.error) };
}

/** Turns Zod issues into instructions a model can act on. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 12).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/**
 * The repair turn.
 *
 * It restates the contract and names every problem, and it deliberately does
 * NOT re-send the original instructions verbatim — a model that has already
 * ignored them once is better served by a narrow correction task.
 */
export function buildRepairInstruction(input: {
  previousOutput: string;
  problems: string[];
}): string {
  return [
    "Your previous response did not satisfy the required output schema.",
    "",
    "Problems found:",
    ...input.problems.map((problem) => `- ${problem}`),
    "",
    "Your previous response was:",
    truncate(input.previousOutput, 4000),
    "",
    "Return a corrected response. Output the JSON value only, with no prose, no",
    "explanation and no code fences. Keep everything that was already correct.",
  ].join("\n");
}

/** Keeps stored excerpts bounded; a runaway response must not bloat a row. */
export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}
