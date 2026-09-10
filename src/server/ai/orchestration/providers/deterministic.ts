import { AIProviderKind } from "@/generated/prisma/enums";
import { AiError } from "../errors";
import { ZERO_USAGE, type ModelProvider, type ModelRequest, type ModelResponse } from "../types";

/**
 * The rule-based provider.
 *
 * It runs the prompt's own `deterministic()` implementation and serialises the
 * result. It makes no network call, costs nothing, and is always available.
 *
 * Three properties are deliberate:
 *
 *  - It declares `DETERMINISTIC`, and `model` is null. The runner writes both
 *    onto the job, `provenanceLabel()` renders them, and the UI says "generated
 *    by rules". There is no configuration that makes it look like a model.
 *  - Its output goes through exactly the same schema validation as model output,
 *    so a rule that drifts out of contract fails visibly instead of shipping a
 *    malformed object that a model would have been blamed for.
 *  - It refuses a repair request. Repair exists because generation is
 *    unreliable; a rule that produced invalid output will produce the same
 *    invalid output again, and retrying would only hide a bug.
 */
export const deterministicProvider: ModelProvider = {
  name: "deterministic",
  kind: AIProviderKind.DETERMINISTIC,
  model: null,

  availability() {
    return { available: true };
  },

  canServe(request: ModelRequest): boolean {
    return typeof request.computeDeterministic === "function";
  },

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!request.computeDeterministic) {
      throw new AiError(
        "UNAVAILABLE",
        `Prompt ${request.promptName} v${request.promptVersion} has no deterministic implementation.`,
      );
    }
    if (request.repair) {
      throw new AiError(
        "INVALID_OUTPUT",
        "The deterministic provider produced output that failed schema validation. This is a bug in the prompt's deterministic implementation, not something a retry can fix.",
      );
    }

    const value = await request.computeDeterministic(request.input);
    return {
      text: JSON.stringify(value),
      usage: ZERO_USAGE,
      costUsd: 0,
      priced: true,
      model: null,
    };
  },
};
