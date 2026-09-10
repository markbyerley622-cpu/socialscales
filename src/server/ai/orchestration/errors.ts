/**
 * Typed failures for the AI boundary.
 *
 * Every failure that crosses the boundary is classified before it is stored, so
 * "the AI broke" is never what an operator reads. The classification decides
 * whether a retry is worth attempting and what the UI is allowed to claim.
 */

export type AiErrorKind =
  /** No provider could serve the request — e.g. no API key configured. */
  | "UNAVAILABLE"
  /** Provider asked us to slow down. Retryable after a wait. */
  | "RATE_LIMIT"
  /** Provider is overloaded. Retryable. */
  | "OVERLOADED"
  /** The call did not complete in time. Retryable. */
  | "TIMEOUT"
  /** Credentials rejected. Not retryable; a human must fix configuration. */
  | "AUTH"
  /** We sent something the provider will not accept. Not retryable as-is. */
  | "BAD_REQUEST"
  /** The model declined to answer. Not retryable; the request needs changing. */
  | "REFUSAL"
  /** The provider answered, but never produced schema-valid output. */
  | "INVALID_OUTPUT"
  /** Transport-level hiccup. Retryable. */
  | "TRANSIENT"
  | "UNKNOWN";

const RETRYABLE: ReadonlySet<AiErrorKind> = new Set<AiErrorKind>([
  "RATE_LIMIT",
  "OVERLOADED",
  "TIMEOUT",
  "TRANSIENT",
]);

export function isRetryable(kind: AiErrorKind): boolean {
  return RETRYABLE.has(kind);
}

export class AiError extends Error {
  readonly kind: AiErrorKind;
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: AiErrorKind,
    message: string,
    options: { cause?: unknown; retryAfterSeconds?: number | null } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AiError";
    this.kind = kind;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  get retryable(): boolean {
    return isRetryable(this.kind);
  }
}

/**
 * Last-resort classification for anything that is not already an AiError.
 *
 * Providers classify their own SDK errors — they know the error classes. This
 * exists so an unexpected throw from anywhere still lands in a known bucket
 * rather than being recorded as an opaque string.
 */
export function classifyAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (/\b(429|rate.?limit|too many requests)\b/.test(lower)) {
    return new AiError("RATE_LIMIT", message, { cause: error });
  }
  if (/\b(529|overload|capacity)\b/.test(lower)) {
    return new AiError("OVERLOADED", message, { cause: error });
  }
  if (/time.?d?.?out|timeout|etimedout|aborted/.test(lower)) {
    return new AiError("TIMEOUT", message, { cause: error });
  }
  if (/\b(401|403|unauthor|forbidden|invalid.*api.?key|authentication)\b/.test(lower)) {
    return new AiError("AUTH", message, { cause: error });
  }
  if (/\b(400|invalid.?request|bad request|unprocessable)\b/.test(lower)) {
    return new AiError("BAD_REQUEST", message, { cause: error });
  }
  if (/econnreset|econnrefused|enotfound|socket hang up|network|fetch failed/.test(lower)) {
    return new AiError("TRANSIENT", message, { cause: error });
  }
  return new AiError("UNKNOWN", message, { cause: error });
}

/**
 * Strips anything that looks like a credential out of a message before it is
 * stored or logged. Provider SDKs sometimes echo request headers on error.
 */
export function redact(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(x-api-key|authorization|api[_-]?key)(\s*[:=]\s*)("?)[^\s"',}]+/gi, "$1$2$3***");
}
