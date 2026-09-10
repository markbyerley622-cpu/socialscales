import { Platform } from "@/generated/prisma/enums";
import { instagramAdapter } from "./instagram";
import { tiktokAdapter } from "./tiktok";
import { youtubeAdapter } from "./youtube";
import type {
  CapabilityMode,
  PlatformCapability,
  SocialPlatform,
} from "./types";

/**
 * The only place that knows which adapters exist. Everything else resolves a
 * platform through here, so the scheduler and worker contain no per-platform
 * branching.
 */
const adapters: Record<Platform, SocialPlatform> = {
  [Platform.TIKTOK]: tiktokAdapter,
  [Platform.INSTAGRAM]: instagramAdapter,
  [Platform.YOUTUBE]: youtubeAdapter,
};

export function getAdapter(platform: Platform): SocialPlatform {
  const adapter = adapters[platform];
  if (!adapter) {
    throw new Error(`No adapter registered for platform ${platform}.`);
  }
  return adapter;
}

export function listAdapters(): SocialPlatform[] {
  return Object.values(adapters);
}

export function supports(
  platform: Platform,
  capability: PlatformCapability,
): boolean {
  return getAdapter(platform).capabilities[capability] !== "UNSUPPORTED";
}

export function capabilityMode(
  platform: Platform,
  capability: PlatformCapability,
): CapabilityMode {
  return getAdapter(platform).capabilities[capability];
}

/**
 * True when the platform can hold the post itself until a future time. When
 * false, CONTENT OS keeps the job queued and publishes at the moment it is due.
 */
export function usesNativeScheduling(platform: Platform): boolean {
  return capabilityMode(platform, "nativeSchedule") !== "UNSUPPORTED";
}

export * from "./types";
