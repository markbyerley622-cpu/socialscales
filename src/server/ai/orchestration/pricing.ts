import type { ModelUsage } from "./types";

/**
 * What a model call costs.
 *
 * Prices are per million tokens and are recorded into `AIUsageLog.costUsd` at
 * the time of the call, so a later price change never rewrites what past work
 * cost. An unknown model is priced at zero and flagged — quietly guessing a
 * price would be worse than reporting a known-incomplete total.
 */

export type PriceTable = {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
};

/**
 * Anthropic list prices, USD per million tokens.
 *
 * Cache reads bill at 0.1x input and 5-minute cache writes at 1.25x input,
 * which is where the derived numbers below come from.
 */
export const ANTHROPIC_PRICING: Record<string, PriceTable> = {
  "claude-opus-5": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
  },
  "claude-sonnet-5": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
};

export type PricedUsage = {
  usd: number;
  /** False when the model has no entry above, so `usd` is a floor, not a total. */
  priced: boolean;
};

export function priceUsage(
  model: string | null,
  usage: ModelUsage,
  table: Record<string, PriceTable> = ANTHROPIC_PRICING,
): PricedUsage {
  if (!model) return { usd: 0, priced: true }; // deterministic work is free.
  const price = table[model];
  if (!price) return { usd: 0, priced: false };

  const perToken = (perMTok: number, tokens: number) => (perMTok * tokens) / 1_000_000;
  const usd =
    perToken(price.inputPerMTok, usage.inputTokens) +
    perToken(price.outputPerMTok, usage.outputTokens) +
    perToken(price.cacheReadPerMTok, usage.cacheReadTokens) +
    perToken(price.cacheWritePerMTok, usage.cacheWriteTokens);

  // Sub-cent precision matters: a single suggestion can cost a fraction of a
  // cent and a month of them is a real number.
  return { usd: Math.round(usd * 1e6) / 1e6, priced: true };
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
