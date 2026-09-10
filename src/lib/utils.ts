import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** 1.24M / 640K / 8,412 — the console's standard number shape. */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(value / 1_000)}K`;
  return Math.round(value).toLocaleString();
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2);
}

export function fullNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

export function percent(fraction: number, places = 1): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(places)}%`;
}

/** "1.49x" / "0.73x" */
export function multiple(value: number): string {
  return `${value.toFixed(2)}x`;
}

export function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek] ?? "—";
}

/** Minutes past midnight → "7:30 PM" */
export function minuteOfDayLabel(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60) % 24;
  const minutes = minuteOfDay % 60;
  const suffix = hours >= 12 ? "PM" : "AM";
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

export function timeLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function dateLabel(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function dateTimeLabel(date: Date): string {
  return `${dateLabel(date)}, ${timeLabel(date)}`;
}

/** "4m ago" / "2d ago" / "just now" */
export function relativeTime(date: Date, now = new Date()): string {
  const deltaMs = now.getTime() - date.getTime();
  const future = deltaMs < 0;
  const seconds = Math.abs(deltaMs) / 1000;

  const units: Array<[string, number]> = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ];
  for (const [suffix, size] of units) {
    if (seconds >= size) {
      const amount = Math.floor(seconds / size);
      return future ? `in ${amount}${suffix}` : `${amount}${suffix} ago`;
    }
  }
  return future ? "in a moment" : "just now";
}

/** Turns an enum-ish token into readable text: SCREEN_RECORDING → Screen recording */
export function humanize(token: string | null | undefined): string {
  if (!token) return "—";
  const lower = token.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function initials(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}
