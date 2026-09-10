import type { ReactNode } from "react";
import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/ui/ops-primitives";

/**
 * A stat tile is the right form when the data's job is a single headline number.
 * The value is the loudest thing in the tile; the label and any delta are
 * secondary ink, never the series colour.
 */

export function StatTile({
  label,
  value,
  hint,
  delta,
  tone = "neutral",
  icon,
  className,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  /** A change worth showing. Direction is carried by an arrow, not colour alone. */
  delta?: { value: string; direction: "up" | "down" | "flat"; good?: boolean };
  tone?: "neutral" | "warning" | "critical" | "accent";
  icon?: ReactNode;
  className?: string;
}) {
  const accentBorder =
    tone === "warning"
      ? "border-warning/30"
      : tone === "critical"
        ? "border-critical/35"
        : tone === "accent"
          ? "border-accent/30"
          : "border-hairline";

  return (
    <div
      className={cn(
        "rounded-[10px] border bg-surface px-3.5 py-3",
        "transition-colors duration-150 hover:bg-surface-raised",
        accentBorder,
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        {icon ? (
          <span className="text-ink-muted [&>svg]:size-3.5">{icon}</span>
        ) : null}
      </div>
      <p className="mt-2 text-[26px] font-semibold leading-none tracking-tight text-ink">
        {value}
      </p>
      <div className="mt-1.5 flex min-h-4 items-center gap-2">
        {delta ? <DeltaChip {...delta} /> : null}
        {hint ? (
          <span className="truncate text-[11px] text-ink-muted">{hint}</span>
        ) : null}
      </div>
    </div>
  );
}

function DeltaChip({
  value,
  direction,
  good,
}: {
  value: string;
  direction: "up" | "down" | "flat";
  good?: boolean;
}) {
  const Icon =
    direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : ArrowRight;
  // Colour reinforces the arrow; the arrow carries the direction on its own.
  const colour =
    direction === "flat"
      ? "text-ink-muted"
      : good === false
        ? "text-[#ec7d7d]"
        : good === true
          ? "text-[#4cc94c]"
          : "text-ink-secondary";
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-[11px] font-medium", colour)}>
      <Icon className="size-3" />
      {value}
    </span>
  );
}

/**
 * The "what's winning" row: a project's recent median against its own all-time
 * median. Renders the honest empty case below the sample threshold.
 */
export function MomentumRow({
  name,
  color,
  momentum,
  publishedCount,
}: {
  name: string;
  color: string;
  momentum: number | null;
  publishedCount: number;
}) {
  const direction =
    momentum === null ? "flat" : momentum >= 1.05 ? "up" : momentum <= 0.95 ? "down" : "flat";

  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ background: color }}
        />
        <span className="truncate text-[12.5px] text-ink">{name}</span>
      </div>
      {momentum === null ? (
        <span className="shrink-0 text-[11px] text-ink-muted">
          {publishedCount} posts · need 6
        </span>
      ) : (
        <DeltaChip
          value={`${momentum.toFixed(2)}x median`}
          direction={direction}
          good={direction === "up" ? true : direction === "down" ? false : undefined}
        />
      )}
    </div>
  );
}
