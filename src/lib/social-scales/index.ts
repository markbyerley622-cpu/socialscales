/**
 * Single place the app resolves its data source.
 *
 * Components import `getAdapter()` from here (via server-side view-model
 * loaders and server actions) and never construct an adapter themselves.
 *
 * There is no fallback. If the configured source cannot be used, this throws
 * and the error boundary shows why — see `data-source.ts` for the reasoning.
 */

import { HttpSocialScalesAdapter } from "./http-adapter";
import { MockSocialScalesAdapter } from "./mock-adapter";
import { PrismaSocialScalesAdapter } from "./prisma-adapter";
import { requireDataSource, resolveDataSource, type DataMode } from "./data-source";
import type { SocialScalesAdapter } from "./adapter";

export type { DataMode };
export {
  DataSourceError,
  requireDataSource,
  resolveDataSource,
  type DataSourceDecision,
} from "./data-source";

/** Kept for callers that only want the mode string. */
export function resolveDataMode(): DataMode {
  const decision = resolveDataSource();
  return decision.ok ? decision.mode : decision.requested;
}

let cached: SocialScalesAdapter | null = null;
let cachedMode: DataMode | null = null;

export function getAdapter(): SocialScalesAdapter {
  // Throws when the configuration is unusable, rather than serving fixtures.
  const { mode } = requireDataSource();

  // The mode is part of the cache key so a changed environment cannot be
  // served by an adapter built for the previous one.
  if (cached && cachedMode === mode) return cached;

  cached =
    mode === "http"
      ? new HttpSocialScalesAdapter({
          baseUrl: process.env.NEXT_PUBLIC_SOCIAL_SCALES_API_URL ?? "",
          token: process.env.SOCIAL_SCALES_API_TOKEN,
        })
      : mode === "mock"
        ? new MockSocialScalesAdapter()
        : new PrismaSocialScalesAdapter();
  cachedMode = mode;

  return cached;
}

/** Test/dev escape hatch — lets a test swap in a stub adapter. */
export function __setAdapterForTesting(adapter: SocialScalesAdapter | null) {
  cached = adapter;
  cachedMode = adapter ? (adapter.mode as DataMode) : null;
}

export * from "./adapter";
export * from "./contracts";
