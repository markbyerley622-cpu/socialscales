import { env } from "@/env";
import { prisma } from "@/server/db";
import { AIJobStatus, AIProviderKind } from "@/generated/prisma/enums";
import type { AIOperation } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { AiError, classifyAiError, redact, type AiErrorKind } from "./errors";
import { anthropicProvider } from "./providers/anthropic";
import { deterministicProvider } from "./providers/deterministic";
import {
  hashInput,
  hashPrompt,
  jsonSchemaFor,
  type PromptDefinition,
} from "./registry";
import {
  ZERO_USAGE,
  type AiJobSummary,
  type AiProvenance,
  type AiResult,
  type ModelProvider,
  type ModelRequest,
  type ModelUsage,
} from "./types";
import { truncate, validateOutput } from "./validate";

/**
 * `runAiOperation` is the AI boundary.
 *
 * Every model interaction in this system passes through here. Routes, React
 * components, strategy services, the content director and workers call this
 * function; none of them may construct a provider or call a model directly.
 *
 * One call runs the full chain:
 *
 *   provider selection -> versioned prompt render -> provider execution
 *   -> schema validation -> repair/retry -> persisted AIJob + AIUsageLog
 *   -> cost and latency accounting -> typed result
 *
 * It does not throw on provider failure. It returns a discriminated union, so a
 * caller cannot accidentally treat a failed generation as a result, and the job
 * row exists either way — a failed job still cost money and still belongs in
 * cost accounting.
 */

export type RunAiOptions<TInput, TOutput> = {
  prompt: PromptDefinition<TInput, TOutput>;
  input: TInput;
  workspaceId: string;
  projectId?: string | null;
  /** Overrides provider selection. Used by tests and by explicit operator choice. */
  provider?: ModelProvider;
  /** Schema-repair attempts after invalid output. Defaults to AI_MAX_REPAIRS. */
  maxRepairs?: number;
  /** Retries for retryable transport failures. Defaults to AI_MAX_RETRIES. */
  maxRetries?: number;
  /** Test seam for deterministic latency accounting. */
  clock?: () => number;
};

export async function runAiOperation<TInput, TOutput>(
  options: RunAiOptions<TInput, TOutput>,
): Promise<AiResult<TOutput>> {
  const { prompt, input } = options;
  const clock = options.clock ?? (() => Date.now());
  const maxRepairs = options.maxRepairs ?? env.model.maxRepairs;
  const maxRetries = options.maxRetries ?? env.model.maxRetries;

  const rendered = prompt.render(input);
  const selection = options.provider
    ? { provider: options.provider, skipped: [] as SkippedProvider[] }
    : selectProvider(prompt);

  const job = await prisma.aIJob.create({
    data: {
      workspaceId: options.workspaceId,
      projectId: options.projectId ?? null,
      operation: prompt.operation,
      status: AIJobStatus.RUNNING,
      providerName: selection.provider?.name ?? "none",
      providerKind: selection.provider?.kind ?? AIProviderKind.DETERMINISTIC,
      model: selection.provider?.model ?? null,
      promptName: prompt.name,
      promptVersion: prompt.version,
      promptHash: hashPrompt(rendered),
      inputHash: hashInput(input),
      input: toJson(input),
      startedAt: new Date(),
    },
  });

  const started = clock();
  let attempt = 0;

  // A provider that could not be used at all is recorded as an attempt with no
  // tokens and no cost, so the trail shows the model was tried and why it was
  // not used, rather than the fallback appearing out of nowhere.
  for (const skipped of selection.skipped) {
    attempt += 1;
    await recordAttempt({
      jobId: job.id,
      attempt,
      provider: skipped.provider,
      usage: ZERO_USAGE,
      costUsd: 0,
      latencyMs: 0,
      ok: false,
      errorKind: "UNAVAILABLE",
    });
  }

  if (!selection.provider) {
    const message =
      selection.skipped
        .map((entry) => `${entry.provider.name}: ${entry.reason}`)
        .join("; ") || "No AI provider is configured.";
    return finish({
      jobId: job.id,
      prompt,
      provenance: provenanceOf(null, prompt),
      status: AIJobStatus.UNAVAILABLE,
      attempts: attempt,
      repairAttempts: 0,
      usage: ZERO_USAGE,
      costUsd: 0,
      latencyMs: clock() - started,
      failure: { kind: "UNAVAILABLE", message },
      validationErrors: [],
    });
  }

  const provider = selection.provider;
  const jsonSchema = jsonSchemaFor(prompt);

  const totals: ModelUsage = { ...ZERO_USAGE };
  let costUsd = 0;
  let repairAttempts = 0;
  let retries = 0;
  const validationErrors: ValidationRecord[] = [];
  let repair: ModelRequest["repair"] | undefined;
  let lastFailure: { kind: AiErrorKind; message: string } = {
    kind: "UNKNOWN",
    message: "No attempt was made.",
  };

  // One loop covers both correction paths. A repair answers invalid output; a
  // retry answers a transient provider failure. They share a budget ceiling so
  // a pathological job cannot spend without bound.
  while (repairAttempts <= maxRepairs && retries <= maxRetries) {
    attempt += 1;
    const attemptStarted = clock();

    const request: ModelRequest = {
      operation: prompt.operation,
      promptName: prompt.name,
      promptVersion: prompt.version,
      system: rendered.system,
      user: rendered.user,
      maxOutputTokens: prompt.maxOutputTokens,
      jsonSchema,
      input,
      computeDeterministic: prompt.deterministic as (value: unknown) => unknown,
      ...(repair ? { repair } : {}),
    };

    let response;
    try {
      response = await provider.complete(request);
    } catch (error) {
      const aiError = classifyAiError(error);
      const latencyMs = clock() - attemptStarted;
      await recordAttempt({
        jobId: job.id,
        attempt,
        provider,
        usage: ZERO_USAGE,
        costUsd: 0,
        latencyMs,
        ok: false,
        errorKind: aiError.kind,
      });
      lastFailure = { kind: aiError.kind, message: redact(aiError.message) };

      if (aiError.retryable && retries < maxRetries) {
        retries += 1;
        continue;
      }
      return finish({
        jobId: job.id,
        prompt,
        provenance: provenanceOf(provider, prompt),
        status: AIJobStatus.FAILED,
        attempts: attempt,
        repairAttempts,
        usage: totals,
        costUsd,
        latencyMs: clock() - started,
        failure: lastFailure,
        validationErrors,
      });
    }

    const latencyMs = clock() - attemptStarted;
    addUsage(totals, response.usage);
    costUsd += response.costUsd;

    await recordAttempt({
      jobId: job.id,
      attempt,
      provider,
      usage: response.usage,
      costUsd: response.costUsd,
      latencyMs,
      ok: true,
      errorKind: null,
    });

    const validated = validateOutput(prompt.schema, response.text);
    // Structure first, then the rules the schema cannot express. Both feed the
    // same repair loop, so a brand-rule violation is corrected here rather than
    // discovered by a human in the approval queue.
    const problems = validated.ok
      ? (prompt.refine?.(validated.value, input) ?? [])
      : validated.problems;

    if (validated.ok && problems.length === 0) {
      return finish({
        jobId: job.id,
        prompt,
        provenance: provenanceOf(provider, prompt),
        status: AIJobStatus.SUCCEEDED,
        attempts: attempt,
        repairAttempts,
        usage: totals,
        costUsd,
        latencyMs: clock() - started,
        output: validated.value,
        validationErrors,
      });
    }

    validationErrors.push({
      attempt,
      problems,
      excerpt: truncate(response.text, 600),
    });
    lastFailure = {
      kind: "INVALID_OUTPUT",
      message: `Output did not satisfy ${prompt.name} v${prompt.version}: ${problems.join("; ")}`,
    };

    if (repairAttempts >= maxRepairs) break;
    repairAttempts += 1;
    repair = { previousOutput: response.text, problems };
  }

  return finish({
    jobId: job.id,
    prompt,
    provenance: provenanceOf(provider, prompt),
    status:
      lastFailure.kind === "INVALID_OUTPUT"
        ? AIJobStatus.INVALID_OUTPUT
        : AIJobStatus.FAILED,
    attempts: attempt,
    repairAttempts,
    usage: totals,
    costUsd,
    latencyMs: clock() - started,
    failure: lastFailure,
    validationErrors,
  });
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

type SkippedProvider = { provider: ModelProvider; reason: string };

/**
 * Picks who serves the request.
 *
 * "auto" prefers the language model and falls back to rules when it is
 * unavailable — the default, so a missing API key never stops work. "anthropic"
 * refuses to fall back, for an operator who would rather see a failure than a
 * rule-generated answer. "deterministic" never calls a model at all, which is
 * what the test suite uses.
 */
export function selectProvider(prompt: { deterministic?: unknown }): {
  provider: ModelProvider | null;
  skipped: SkippedProvider[];
} {
  const mode = env.model.provider.toLowerCase();
  const hasDeterministic = typeof prompt.deterministic === "function";
  const skipped: SkippedProvider[] = [];

  if (mode === "deterministic") {
    return { provider: hasDeterministic ? deterministicProvider : null, skipped };
  }

  const availability = anthropicProvider.availability();
  if (availability.available) {
    return { provider: anthropicProvider, skipped };
  }

  skipped.push({ provider: anthropicProvider, reason: availability.reason });

  if (mode === "anthropic") {
    // Explicitly configured to require the model: do not quietly substitute.
    return { provider: null, skipped };
  }
  return { provider: hasDeterministic ? deterministicProvider : null, skipped };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

type ValidationRecord = { attempt: number; problems: string[]; excerpt: string };

async function recordAttempt(input: {
  jobId: string;
  attempt: number;
  provider: ModelProvider;
  usage: ModelUsage;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
  errorKind: AiErrorKind | null;
}): Promise<void> {
  await prisma.aIUsageLog.create({
    data: {
      aiJobId: input.jobId,
      attempt: input.attempt,
      providerName: input.provider.name,
      providerKind: input.provider.kind,
      model: input.provider.model,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheWriteTokens: input.usage.cacheWriteTokens,
      costUsd: input.costUsd,
      latencyMs: input.latencyMs,
      ok: input.ok,
      errorKind: input.errorKind,
    },
  });
}

async function finish<TOutput>(input: {
  jobId: string;
  prompt: { name: string; version: string; operation: AIOperation };
  provenance: AiProvenance;
  status: AIJobStatus;
  attempts: number;
  repairAttempts: number;
  usage: ModelUsage;
  costUsd: number;
  latencyMs: number;
  output?: TOutput;
  failure?: { kind: AiErrorKind; message: string };
  validationErrors: ValidationRecord[];
}): Promise<AiResult<TOutput>> {
  await prisma.aIJob.update({
    where: { id: input.jobId },
    data: {
      status: input.status,
      providerName: input.provenance.providerName,
      providerKind: input.provenance.providerKind,
      model: input.provenance.model,
      attempts: input.attempts,
      repairAttempts: input.repairAttempts,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      costUsd: round6(input.costUsd),
      latencyMs: input.latencyMs,
      output: input.output === undefined ? undefined : toJson(input.output),
      errorKind: input.failure?.kind ?? null,
      error: input.failure ? truncate(redact(input.failure.message), 2000) : null,
      validationErrors: toJson(input.validationErrors),
      finishedAt: new Date(),
    },
  });

  const summary: AiJobSummary = {
    id: input.jobId,
    operation: input.prompt.operation,
    provenance: input.provenance,
    attempts: input.attempts,
    repairAttempts: input.repairAttempts,
    usage: input.usage,
    costUsd: round6(input.costUsd),
    latencyMs: input.latencyMs,
  };

  if (input.status === AIJobStatus.SUCCEEDED && input.output !== undefined) {
    return { ok: true, value: input.output, job: summary };
  }
  return {
    ok: false,
    errorKind: input.failure?.kind ?? "UNKNOWN",
    message: input.failure
      ? redact(input.failure.message)
      : "The operation did not complete.",
    job: summary,
  };
}

function provenanceOf(
  provider: ModelProvider | null,
  prompt: { name: string; version: string },
): AiProvenance {
  const kind = provider?.kind ?? AIProviderKind.DETERMINISTIC;
  return {
    providerName: provider?.name ?? "none",
    providerKind: kind,
    model: provider?.model ?? null,
    promptName: prompt.name,
    promptVersion: prompt.version,
    // Derived from the provider's own declaration, never from the model field
    // or the provider's name, so there is one source of truth for the claim.
    deterministic: kind === AIProviderKind.DETERMINISTIC,
  };
}

function addUsage(target: ModelUsage, delta: ModelUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

export { AiError };
