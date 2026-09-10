"use client";

import { useMemo, useRef, useState } from "react";
import { compactNumber, fullNumber, percent } from "@/lib/utils";

/**
 * Daily views, as an area with a 2px line on top.
 *
 * Hand-drawn SVG rather than a chart library: three chart forms did not justify
 * the dependency, and this way the mark spec is exact — 2px line, recessive
 * hairline grid, one axis, a crosshair with a tooltip on hover, and no number
 * printed on every point.
 *
 * One series, so no legend: the card title names it.
 */

export type TrendPoint = {
  date: string;
  views: number;
  posts: number;
  engagementRate: number;
};

const WIDTH = 720;
const HEIGHT = 168;
const PADDING = { top: 12, right: 8, bottom: 20, left: 8 };

export function ViewsTrend({ data }: { data: TrendPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const geometry = useMemo(() => {
    const innerWidth = WIDTH - PADDING.left - PADDING.right;
    const innerHeight = HEIGHT - PADDING.top - PADDING.bottom;
    const maxViews = Math.max(1, ...data.map((point) => point.views));
    // Headroom so the peak never touches the top edge.
    const scaleMax = maxViews * 1.12;

    const x = (index: number) =>
      data.length <= 1
        ? PADDING.left + innerWidth / 2
        : PADDING.left + (index / (data.length - 1)) * innerWidth;
    const y = (value: number) =>
      PADDING.top + innerHeight - (value / scaleMax) * innerHeight;

    const points = data.map((point, index) => ({
      ...point,
      cx: x(index),
      cy: y(point.views),
    }));

    const line = points
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.cx.toFixed(2)} ${point.cy.toFixed(2)}`)
      .join(" ");

    const baseline = PADDING.top + innerHeight;
    const area =
      points.length > 0
        ? `${line} L${points[points.length - 1].cx.toFixed(2)} ${baseline} L${points[0].cx.toFixed(2)} ${baseline} Z`
        : "";

    // Four gridlines including the baseline.
    const gridValues = [0.25, 0.5, 0.75, 1].map((fraction) => scaleMax * fraction);

    return { points, line, area, baseline, gridValues, y, scaleMax, innerWidth };
  }, [data]);

  function handleMove(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || geometry.points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    // Map client x into the viewBox coordinate space.
    const ratio = (event.clientX - rect.left) / rect.width;
    const viewX = ratio * WIDTH;
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [index, point] of geometry.points.entries()) {
      const distance = Math.abs(point.cx - viewX);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
    }
    setHoverIndex(nearest);
  }

  const active = hoverIndex === null ? null : geometry.points[hoverIndex];
  const total = data.reduce((sum, point) => sum + point.views, 0);

  if (data.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-[11.5px] text-ink-muted">
        Nothing published in this range yet.
      </p>
    );
  }

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block h-[168px] w-full touch-none"
        role="img"
        aria-label={`Daily views over ${data.length} days, ${fullNumber(total)} views in total`}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id="views-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Recessive grid: hairlines, never competing with the data. */}
        {geometry.gridValues.map((value) => (
          <line
            key={value}
            x1={PADDING.left}
            x2={WIDTH - PADDING.right}
            y1={geometry.y(value)}
            y2={geometry.y(value)}
            stroke="var(--color-grid)"
            strokeWidth="1"
          />
        ))}
        <line
          x1={PADDING.left}
          x2={WIDTH - PADDING.right}
          y1={geometry.baseline}
          y2={geometry.baseline}
          stroke="var(--color-axis)"
          strokeWidth="1"
        />

        <path d={geometry.area} fill="url(#views-fill)" />
        <path
          d={geometry.line}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {active ? (
          <>
            <line
              x1={active.cx}
              x2={active.cx}
              y1={PADDING.top}
              y2={geometry.baseline}
              stroke="var(--color-hairline-strong)"
              strokeWidth="1"
            />
            {/* 2px surface ring so the marker reads against the line beneath it. */}
            <circle
              cx={active.cx}
              cy={active.cy}
              r="5"
              fill="var(--color-accent)"
              stroke="var(--color-surface)"
              strokeWidth="2"
            />
          </>
        ) : null}
      </svg>

      {/* Axis labels: first, middle and last only. Anything denser collides. */}
      <div className="flex justify-between px-2 text-[10px] tabular text-ink-muted">
        <span>{formatAxisDate(data[0].date)}</span>
        {data.length > 2 ? (
          <span>{formatAxisDate(data[Math.floor(data.length / 2)].date)}</span>
        ) : null}
        <span>{formatAxisDate(data[data.length - 1].date)}</span>
      </div>

      {active ? (
        <div
          className="pointer-events-none absolute top-1 z-10 w-max max-w-[220px] rounded-md border border-hairline-strong bg-surface-raised px-2.5 py-2 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.9)]"
          style={{
            left: `calc(${(active.cx / WIDTH) * 100}% + ${active.cx / WIDTH > 0.6 ? -12 : 12}px)`,
            transform: active.cx / WIDTH > 0.6 ? "translateX(-100%)" : undefined,
          }}
        >
          <p className="text-[11px] font-medium text-ink">{formatTooltipDate(active.date)}</p>
          <dl className="mt-1 space-y-0.5">
            <TooltipRow label="Views" value={fullNumber(active.views)} />
            <TooltipRow label="Posts" value={String(active.posts)} />
            <TooltipRow label="Engagement" value={percent(active.engagementRate)} />
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[10.5px] text-ink-muted">{label}</dt>
      <dd className="text-[11px] tabular text-ink">{value}</dd>
    </div>
  );
}

function formatAxisDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTooltipDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * A sparkline for project cards. No axes, no tooltip: it exists to show shape,
 * and the card's own numbers carry the values.
 */
export function Sparkline({
  values,
  color,
  className,
}: {
  values: number[];
  color: string;
  className?: string;
}) {
  if (values.length < 2) {
    return <div className={className} aria-hidden />;
  }
  const width = 120;
  const height = 28;
  const max = Math.max(1, ...values);
  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (value / max) * (height - 3) - 1.5;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={`Recent trend, peak ${compactNumber(max)} views`}
      preserveAspectRatio="none"
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
