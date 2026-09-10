import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCount(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return value.toLocaleString("en-GB");
}

export function formatMetric(value: number, format: "COUNT" | "PERCENT" | "DURATION_SEC"): string {
  switch (format) {
    case "PERCENT":
      return `${value}%`;
    case "DURATION_SEC":
      return value >= 60 ? `${Math.floor(value / 60)}m ${value % 60}s` : `${value}s`;
    default:
      return formatCount(value);
  }
}

export function formatDelta(delta: number | null): string | null {
  if (delta === null) return null;
  return `${delta > 0 ? "+" : ""}${delta}%`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function relativeFrom(isoDate: string, now: Date): string {
  const then = new Date(isoDate).getTime();
  const diffMinutes = Math.round((now.getTime() - then) / 60000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;

  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;

  return `${Math.round(days / 7)} week${Math.round(days / 7) === 1 ? "" : "s"} ago`;
}
