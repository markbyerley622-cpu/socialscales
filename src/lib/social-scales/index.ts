/**
 * Single place the app resolves its data source.
 *
 * Components import `getAdapter()` from here (via server-side view-model
 * loaders and server actions) and never construct an adapter themselves.
 */

import { HttpSocialScalesAdapter } from "./http-adapter";
import { MockSocialScalesAdapter } from "./mock-adapter";
import type { SocialScalesAdapter } from "./adapter";

export type DataMode = "mock" | "http";

export function resolveDataMode(): DataMode {
  const raw = process.env.SOCIAL_SCALES_DATA_MODE?.toLowerCase();
  return raw === "http" ? "http" : "mock";
}

let cached: SocialScalesAdapter | null = null;

export function getAdapter(): SocialScalesAdapter {
  if (cached) return cached;

  cached =
    resolveDataMode() === "http"
      ? new HttpSocialScalesAdapter({
          baseUrl: process.env.NEXT_PUBLIC_SOCIAL_SCALES_API_URL ?? "",
          token: process.env.SOCIAL_SCALES_API_TOKEN,
        })
      : new MockSocialScalesAdapter();

  return cached;
}

/** Test/dev escape hatch — lets a test swap in a stub adapter. */
export function __setAdapterForTesting(adapter: SocialScalesAdapter | null) {
  cached = adapter;
}

export * from "./adapter";
export * from "./contracts";
