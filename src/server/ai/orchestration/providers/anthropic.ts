import type Anthropic from "@anthropic-ai/sdk";
import { env } from "@/env";
import { AIProviderKind } from "@/generated/prisma/enums";
import { AiError, redact } from "../errors";
import { priceUsage } from "../pricing";
import { buildRepairInstruction } from "../validate";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ProviderAvailability,
} from "../types";

/**
 * The Anthropic provider.
 *
 * Inactive until ANTHROPIC_API_KEY is configured, and inactive is a first-class
 * state rather than a crash: `availability()` reports why, the runner records
 * the reason on the job, and the deterministic provider serves the request. The
 * whole system therefore works with no key at all, honestly labelled.
 *
 * The SDK is imported dynamically so a deployment that never uses a model does
 * not load it, and so a missing package degrades to "unavailable" instead of
 * breaking the process at import time.
 *
 * The key is read from `env` and used only to construct the client. It is never
 * logged, never written to a job record, and error messages are redacted before
 * they are stored.
 */

/**
 * Headroom above the prompt's output budget, because adaptive thinking tokens
 * count against max_tokens. Without it a prompt that asks for 4k of JSON can be
 * truncated mid-object by its own reasoning.
 */
const THINKING_HEADROOM_TOKENS = 8_000;

type AnthropicModule = typeof import("@anthropic-ai/sdk");

let cachedModule: AnthropicModule | null = null;
let moduleLoadError: string | null = null;
let cachedClient: Anthropic | null = null;
let cachedClientKey: string | null = null;

async function loadModule(): Promise<AnthropicModule | null> {
  if (cachedModule) return cachedModule;
  if (moduleLoadError) return null;
  try {
    cachedModule = (await import("@anthropic-ai/sdk")) as AnthropicModule;
    return cachedModule;
  } catch (error) {
    moduleLoadError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

async function getClient(): Promise<Anthropic> {
  const apiKey = env.model.anthropicApiKey;
  if (!apiKey) {
    throw new AiError("UNAVAILABLE", "ANTHROPIC_API_KEY is not configured.");
  }
  if (cachedClient && cachedClientKey === apiKey) return cachedClient;

  const mod = await loadModule();
  if (!mod) {
    throw new AiError(
      "UNAVAILABLE",
      `@anthropic-ai/sdk could not be loaded: ${moduleLoadError ?? "unknown reason"}`,
    );
  }
  cachedClient = new mod.default({
    apiKey,
    timeout: env.model.requestTimeoutMs,
    // Retries are handled by the runner, which records each attempt in
    // AIUsageLog. Letting the SDK retry silently would understate attempts.
    maxRetries: 0,
  });
  cachedClientKey = apiKey;
  return cachedClient;
}

export const anthropicProvider: ModelProvider = {
  name: "anthropic",
  kind: AIProviderKind.LLM,
  model: env.model.name,

  availability(): ProviderAvailability {
    if (!env.model.anthropicApiKey) {
      return {
        available: false,
        reason:
          "ANTHROPIC_API_KEY is not configured, so model-generated results are unavailable.",
      };
    }
    if (moduleLoadError) {
      return { available: false, reason: `@anthropic-ai/sdk failed to load: ${moduleLoadError}` };
    }
    return { available: true };
  },

  canServe(): boolean {
    return true;
  },

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const client = await getClient();
    const model = env.model.name;

    const userContent = request.repair
      ? buildRepairInstruction(request.repair)
      : request.user;

    let message: Anthropic.Messages.Message;
    try {
      message = await client.messages.create({
        model,
        max_tokens: request.maxOutputTokens + THINKING_HEADROOM_TOKENS,
        system: request.system,
        // Adaptive thinking: the model decides how much reasoning a request
        // warrants. Only the structured result is ever read or stored — the
        // reasoning itself is never surfaced or persisted.
        thinking: { type: "adaptive" },
        // Native schema enforcement. Zod remains the authority: the runner
        // validates the result regardless of what the provider guarantees.
        output_config: { format: { type: "json_schema", schema: request.jsonSchema } },
        messages: [{ role: "user", content: userContent }],
      });
    } catch (error) {
      throw toAiError(error);
    }

    if (message.stop_reason === "refusal") {
      throw new AiError(
        "REFUSAL",
        "The model declined to answer this request. Change the request rather than retrying it.",
      );
    }

    const text = message.content
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    if (message.stop_reason === "max_tokens") {
      throw new AiError(
        "INVALID_OUTPUT",
        `Response hit the ${request.maxOutputTokens} token output budget and was cut off. Raise the prompt's maxOutputTokens or ask for less.`,
      );
    }

    const usage = readUsage(message.usage);
    const priced = priceUsage(model, usage);

    return { text, usage, costUsd: priced.usd, priced: priced.priced, model };
  },
};

function readUsage(usage: Anthropic.Messages.Usage): ModelUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Maps SDK errors onto our classification.
 *
 * Keyed on HTTP status rather than on error-class identity, because the class
 * is only reachable through the dynamically imported module and a status is
 * unambiguous either way.
 */
function toAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;

  const status = (error as { status?: number } | null)?.status;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = redact(rawMessage);
  const headers = (error as { headers?: Record<string, string> } | null)?.headers;
  const retryAfter = headers?.["retry-after"];
  const retryAfterSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : null;

  switch (status) {
    case 400:
    case 404:
    case 413:
    case 422:
      return new AiError("BAD_REQUEST", message, { cause: error });
    case 401:
    case 403:
      return new AiError("AUTH", message, { cause: error });
    case 408:
      return new AiError("TIMEOUT", message, { cause: error });
    case 429:
      return new AiError("RATE_LIMIT", message, {
        cause: error,
        retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
      });
    case 500:
    case 502:
    case 503:
      return new AiError("TRANSIENT", message, { cause: error });
    case 529:
      return new AiError("OVERLOADED", message, { cause: error });
    default:
      break;
  }

  const lower = rawMessage.toLowerCase();
  if (/timeout|timed out|aborted/.test(lower)) {
    return new AiError("TIMEOUT", message, { cause: error });
  }
  if (/econnreset|econnrefused|enotfound|socket hang up|fetch failed|network/.test(lower)) {
    return new AiError("TRANSIENT", message, { cause: error });
  }
  return new AiError("UNKNOWN", message, { cause: error });
}

/** Test seam: drops the memoised client so a changed key takes effect. */
export function resetAnthropicClient(): void {
  cachedClient = null;
  cachedClientKey = null;
}
