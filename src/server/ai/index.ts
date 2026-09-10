import { env } from "@/env";
import { heuristicProvider } from "./heuristic-provider";
import type { AiProvider } from "./types";

const providers: Record<string, AiProvider> = {
  heuristic: heuristicProvider,
};

/**
 * Resolves the configured provider. Unknown names fall back to the heuristic
 * provider with a warning rather than crashing the worker, because a typo in
 * AI_PROVIDER should not stop content from publishing.
 */
export function getAiProvider(name: string = env.aiProvider): AiProvider {
  const provider = providers[name];
  if (provider) return provider;
  console.warn(
    `[ai] unknown AI_PROVIDER "${name}"; falling back to "heuristic". Known: ${Object.keys(providers).join(", ")}`,
  );
  return heuristicProvider;
}

export function listProviders(): string[] {
  return Object.keys(providers);
}

export * from "./types";
