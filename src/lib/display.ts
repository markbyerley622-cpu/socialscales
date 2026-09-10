/**
 * Presentation-only mappings from domain enums to visual treatment.
 * Keeping these in one file is what stops status colours drifting per page.
 */

import type {
  ContentStatus,
  GenerationStatus,
  IntegrationStatus,
  Platform,
} from "@/lib/social-scales/contracts";

export const PLATFORM_META: Record<Platform, { label: string; short: string; className: string }> = {
  TIKTOK: { label: "TikTok", short: "TT", className: "text-ink bg-white/10" },
  INSTAGRAM: { label: "Instagram", short: "IG", className: "text-[#f0a5c8] bg-[#f0a5c8]/12" },
  YOUTUBE: { label: "YouTube", short: "YT", className: "text-[#ff8080] bg-[#ff8080]/12" },
  LINKEDIN: { label: "LinkedIn", short: "in", className: "text-[#7db8ff] bg-[#7db8ff]/12" },
  X: { label: "X", short: "X", className: "text-ink bg-white/10" },
};

export interface StatusTone {
  label: string;
  /** Tailwind classes for a small pill. */
  className: string;
  dot: string;
}

export const CONTENT_STATUS_META: Record<ContentStatus, StatusTone> = {
  IDEA: { label: "Idea", className: "text-ink-muted bg-white/6 border-hairline", dot: "bg-ink-faint" },
  BRIEF: { label: "Brief", className: "text-ink-muted bg-white/6 border-hairline", dot: "bg-ink-faint" },
  SCRIPT: { label: "Script", className: "text-violet bg-violet/10 border-violet/25", dot: "bg-violet" },
  ASSET_READY: { label: "Assets ready", className: "text-info bg-info/10 border-info/25", dot: "bg-info" },
  GENERATING: { label: "Generating", className: "text-accent bg-accent/10 border-accent/30", dot: "bg-accent" },
  NEEDS_REVIEW: { label: "Needs review", className: "text-warn bg-warn/10 border-warn/28", dot: "bg-warn" },
  APPROVED: { label: "Approved", className: "text-ok bg-ok/10 border-ok/25", dot: "bg-ok" },
  SCHEDULED: { label: "Scheduled", className: "text-accent bg-accent/10 border-accent/25", dot: "bg-accent" },
  PUBLISHED: { label: "Published", className: "text-ok bg-ok/8 border-ok/20", dot: "bg-ok" },
  FAILED: { label: "Failed", className: "text-danger bg-danger/10 border-danger/28", dot: "bg-danger" },
};

export const GENERATION_STATUS_META: Record<GenerationStatus, StatusTone> = {
  QUEUED: { label: "Queued", className: "text-ink-muted bg-white/6 border-hairline", dot: "bg-ink-faint" },
  PLANNING: { label: "Planning", className: "text-info bg-info/10 border-info/25", dot: "bg-info" },
  GENERATING: { label: "Generating", className: "text-accent bg-accent/10 border-accent/30", dot: "bg-accent" },
  RENDERING: { label: "Rendering", className: "text-accent bg-accent/10 border-accent/30", dot: "bg-accent" },
  QA: { label: "QA", className: "text-violet bg-violet/10 border-violet/25", dot: "bg-violet" },
  READY: { label: "Ready", className: "text-ok bg-ok/10 border-ok/25", dot: "bg-ok" },
  FAILED: { label: "Failed", className: "text-danger bg-danger/10 border-danger/28", dot: "bg-danger" },
};

export const INTEGRATION_STATUS_META: Record<IntegrationStatus, StatusTone> = {
  NOT_CONNECTED: { label: "Not connected", className: "text-ink-muted bg-white/6 border-hairline", dot: "bg-ink-faint" },
  CONNECTING: { label: "Connecting", className: "text-info bg-info/10 border-info/25", dot: "bg-info" },
  CONNECTED: { label: "Connected", className: "text-ok bg-ok/10 border-ok/25", dot: "bg-ok" },
  NEEDS_REAUTH: { label: "Needs reauth", className: "text-warn bg-warn/10 border-warn/28", dot: "bg-warn" },
  ERROR: { label: "Error", className: "text-danger bg-danger/10 border-danger/28", dot: "bg-danger" },
};

/**
 * Decorative gradients standing in for media thumbnails. The standalone build
 * ships no stock photography — real deployments render the actual frame.
 */
export const TONE_GRADIENTS: Record<string, string> = {
  cyan: "bg-[linear-gradient(140deg,#0b3d4a,#0a2230_55%,#071722)]",
  violet: "bg-[linear-gradient(140deg,#33265c,#1d1836_55%,#120f24)]",
  teal: "bg-[linear-gradient(140deg,#12463f,#0c2a29_55%,#08191b)]",
  indigo: "bg-[linear-gradient(140deg,#1f2f5c,#151f3c_55%,#0d1426)]",
  amber: "bg-[linear-gradient(140deg,#4a3416,#2c1f10_55%,#1a1309)]",
  slate: "bg-[linear-gradient(140deg,#233040,#161f2a_55%,#0d141c)]",
};

export function toneClass(tone: string): string {
  return TONE_GRADIENTS[tone] ?? TONE_GRADIENTS.slate;
}

export const PILLAR_COLOR: Record<string, string> = {
  accent: "text-accent bg-accent/12 border-accent/25",
  violet: "text-violet bg-violet/12 border-violet/25",
  ok: "text-ok bg-ok/12 border-ok/25",
  warn: "text-warn bg-warn/12 border-warn/25",
  info: "text-info bg-info/12 border-info/25",
};

export const PILLAR_BAR: Record<string, string> = {
  accent: "bg-accent",
  violet: "bg-violet",
  ok: "bg-ok",
  warn: "bg-warn",
  info: "bg-info",
};
