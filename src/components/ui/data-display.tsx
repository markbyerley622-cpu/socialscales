import * as React from "react";

import {
  CONTENT_STATUS_META,
  GENERATION_STATUS_META,
  INTEGRATION_STATUS_META,
  PLATFORM_META,
  toneClass,
} from "@/lib/display";
import type {
  ContentStatus,
  GenerationStatus,
  IntegrationStatus,
  Platform,
} from "@/lib/social-scales/contracts";
import { cn, formatDelta, formatMetric } from "@/lib/utils";

import { Badge, DeltaPill } from "./primitives";

const SPARKLINE_GRADIENT_ID = "ss-sparkline-fill";

export function StatusBadge({ status, className }: { status: ContentStatus; className?: string }) {
  const meta = CONTENT_STATUS_META[status];
  return (
    <Badge className={cn(meta.className, className)} dot={meta.dot}>
      {meta.label}
    </Badge>
  );
}

export function GenerationBadge({ status, className }: { status: GenerationStatus; className?: string }) {
  const meta = GENERATION_STATUS_META[status];
  return (
    <Badge className={cn(meta.className, className)} dot={meta.dot}>
      {meta.label}
    </Badge>
  );
}

export function IntegrationBadge({ status, className }: { status: IntegrationStatus; className?: string }) {
  const meta = INTEGRATION_STATUS_META[status];
  return (
    <Badge className={cn(meta.className, className)} dot={meta.dot}>
      {meta.label}
    </Badge>
  );
}

export function PlatformChip({
  platform,
  showLabel = false,
  className,
}: {
  platform: Platform;
  showLabel?: boolean;
  className?: string;
}) {
  const meta = PLATFORM_META[platform];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
        meta.className,
        className,
      )}
      title={meta.label}
    >
      <span aria-hidden>{meta.short}</span>
      {showLabel ? <span className="font-medium">{meta.label}</span> : <span className="sr-only">{meta.label}</span>}
    </span>
  );
}

/**
 * Stands in for a media thumbnail. The standalone build intentionally ships no
 * stock imagery — a tone gradient plus the platform mark reads as a real frame
 * without pretending to be one.
 */
export function Thumb({
  tone,
  platform,
  duration,
  className,
  children,
}: {
  tone: string;
  platform?: Platform;
  duration?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-hairline",
        toneClass(tone),
        className,
      )}
    >
      <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_20%_0%,rgba(255,255,255,0.10),transparent_60%)]" />
      {platform ? (
        <span className="absolute top-1 left-1 z-10">
          <PlatformChip platform={platform} />
        </span>
      ) : null}
      {duration ? (
        <span className="absolute right-1 bottom-1 z-10 rounded bg-black/60 px-1 py-px text-[10px] font-medium text-ink">
          {duration}
        </span>
      ) : null}
      {children}
    </div>
  );
}

export function KpiCard({
  label,
  value,
  format = "COUNT",
  delta,
  icon,
  className,
}: {
  label: string;
  value: number;
  format?: "COUNT" | "PERCENT" | "DURATION_SEC";
  delta?: number | null;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] border border-hairline bg-surface-2/70 p-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {icon ? (
          <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent/8 text-accent">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0">
          <p className="text-[22px] leading-tight font-semibold tracking-tight text-ink tabular-nums">
            {formatMetric(value, format)}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-ink-muted">{label}</p>
          {delta !== undefined ? (
            <p className="mt-1.5">
              <DeltaPill value={delta} />
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Dependency-free sparkline — safe to render in a server component. */
export function Sparkline({
  points,
  className,
  height = 40,
  strokeClassName = "stroke-accent",
  fill = true,
}: {
  points: number[];
  className?: string;
  height?: number;
  strokeClassName?: string;
  fill?: boolean;
}) {
  if (points.length < 2) return null;

  const width = 100;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;

  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * width;
    const y = height - ((p - min) / span) * (height - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const line = `M ${coords.join(" L ")}`;
  const area = `${line} L ${width},${height} L 0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
      style={{ height }}
      aria-hidden
    >
      <defs>
        {/* Shared id: every sparkline uses the identical gradient, so one definition is enough. */}
        <linearGradient id={SPARKLINE_GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill ? <path d={area} fill={`url(#${SPARKLINE_GRADIENT_ID})`} className="text-accent" /> : null}
      <path d={line} fill="none" strokeWidth="1.5" className={strokeClassName} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function MetricRow({
  label,
  value,
  format,
  delta,
}: {
  label: string;
  value: number;
  format: "COUNT" | "PERCENT" | "DURATION_SEC";
  delta: number | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-2.5 last:border-b-0">
      <span className="text-[13px] text-ink-muted">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="text-[14px] font-semibold text-ink tabular-nums">{formatMetric(value, format)}</span>
        {delta !== null ? (
          <span className={cn("text-[11px]", delta >= 0 ? "text-ok" : "text-danger")}>{formatDelta(delta)}</span>
        ) : null}
      </span>
    </div>
  );
}
