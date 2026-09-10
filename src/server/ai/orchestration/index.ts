/**
 * The AI orchestration boundary.
 *
 * Import `runAiOperation` and a registered prompt. Do not import a provider, do
 * not construct a client, and do not call a model from a route, a component, a
 * strategy service, the content director or a worker — the whole point of this
 * module is that there is exactly one place where model interaction happens and
 * exactly one place where it is recorded.
 */
export { runAiOperation, selectProvider, type RunAiOptions } from "./run";
export {
  AiError,
  classifyAiError,
  isRetryable,
  redact,
  type AiErrorKind,
} from "./errors";
export {
  getPrompt,
  hashInput,
  hashPrompt,
  jsonSchemaFor,
  listPrompts,
  promptsFor,
  registerPrompt,
  type AnyPrompt,
  type PromptDefinition,
  type RenderedPrompt,
} from "./registry";
export {
  provenanceLabel,
  ZERO_USAGE,
  type AiJobSummary,
  type AiProvenance,
  type AiResult,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type ProviderAvailability,
} from "./types";
export {
  ANTHROPIC_PRICING,
  formatUsd,
  priceUsage,
  type PriceTable,
  type PricedUsage,
} from "./pricing";
export { deterministicProvider } from "./providers/deterministic";
export { anthropicProvider, resetAnthropicClient } from "./providers/anthropic";
export {
  aiSpend,
  aiSpendByOperation,
  recentAiSpend,
  type AiSpend,
  type OperationSpend,
  type SpendWindow,
} from "./accounting";
export { aiBoundaryStatus, type AiBoundaryStatus } from "./status";
export * from "./prompts";
