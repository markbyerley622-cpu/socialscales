/**
 * Single place the app resolves its data source.
 *
 * Components import `getAdapter()` from here (via server-side view-model
 * loaders and server actions) and never construct an adapter themselves.
 */

import { HttpSocialScalesAdapter } from "./http-adapter";
import { MockSocialScalesAdapter } from "./mock-adapter";
import { PrismaSocialScalesAdapter } from "./prisma-adapter";
import type { SocialScalesAdapter } from "./adapter";

export type DataMode = "mock" | "http" | "prisma";

/**
 * Which data source the dashboard reads.
 *
 * `prisma` is the default now that the UI lives inside the backend: it calls
 * this app's own services directly, with no HTTP hop and no second deployment.
 * `mock` still works for UI development without a database, and `http` remains
 * for a split deployment.
 */
export function resolveDataMode(): DataMode {
  const raw = process.env.SOCIAL_SCALES_DATA_MODE?.toLowerCase();
  if (raw === "http") return "http";
  if (raw === "mock") return "mock";
  return "prisma";
}

let cached: SocialScalesAdapter | null = null;

export function getAdapter(): SocialScalesAdapter {
  if (cached) return cached;

  const mode = resolveDataMode();
  cached =
    mode === "http"
      ? new HttpSocialScalesAdapter({
          baseUrl: process.env.NEXT_PUBLIC_SOCIAL_SCALES_API_URL ?? "",
          token: process.env.SOCIAL_SCALES_API_TOKEN,
        })
      : mode === "mock"
        ? new MockSocialScalesAdapter()
        : new PrismaSocialScalesAdapter();

  return cached;
}

/** Test/dev escape hatch — lets a test swap in a stub adapter. */
export function __setAdapterForTesting(adapter: SocialScalesAdapter | null) {
  cached = adapter;
}

export * from "./adapter";
export * from "./contracts";
