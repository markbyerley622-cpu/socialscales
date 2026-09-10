import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The console's shared surfaces and text shapes. Deliberately small: a handful of
 * composable pieces rather than a component per screen.
 */

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-[10px] border border-hairline bg-surface",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset,0_8px_24px_-16px_rgba(0,0,0,0.7)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex items-start justify-between gap-4 border-b border-hairline px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted",
        className,
      )}
    >
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export type BadgeTone =
  | "neutral"
  | "accent"
  | "good"
  | "warning"
  | "serious"
  | "critical"
  | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "border-hairline-strong bg-surface-raised text-ink-secondary",
  accent: "border-accent/35 bg-accent/12 text-accent-ink",
  good: "border-good/40 bg-good/12 text-[#4cc94c]",
  warning: "border-warning/40 bg-warning/12 text-[#f6c455]",
  serious: "border-serious/40 bg-serious/12 text-[#f0a180]",
  critical: "border-critical/45 bg-critical/14 text-[#ec7d7d]",
  info: "border-above/40 bg-above/12 text-[#6ea9ee]",
};

export function Badge({
  tone = "neutral",
  icon,
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  /** Status badges must carry an icon: colour never carries meaning alone. */
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-[3px]",
        "text-[10.5px] font-medium leading-none whitespace-nowrap",
        BADGE_TONES[tone],
        className,
      )}
    >
      {icon ? <span className="shrink-0 [&>svg]:size-3">{icon}</span> : null}
      {children}
    </span>
  );
}

/** A small coloured dot used to carry project identity next to its name. */
export function ProjectDot({
  color,
  className,
}: {
  color: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", className)}
      style={{ background: color, boxShadow: `0 0 0 3px ${color}22` }}
    />
  );
}

// ---------------------------------------------------------------------------
// Empty and error states
// ---------------------------------------------------------------------------

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="mb-1 grid size-9 place-items-center rounded-full border border-hairline bg-surface-raised text-ink-muted [&>svg]:size-4">
          {icon}
        </div>
      ) : null}
      <p className="text-[13px] font-medium text-ink">{title}</p>
      <p className="max-w-[46ch] text-[11.5px] leading-relaxed text-ink-muted">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * Used wherever a number would be misleading without its caveat — the "needs more
 * data" state that the spec asks for instead of a fabricated score.
 */
export function InsufficientData({
  needed,
  have,
  what,
}: {
  needed: number;
  have: number;
  what: string;
}) {
  return (
    <p className="text-[11.5px] leading-relaxed text-ink-muted">
      Not enough data yet: {have} of {needed} {what} needed before this is
      reported as a finding rather than noise.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

export function KeyValue({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <SectionLabel>{label}</SectionLabel>
      <div className="text-[12.5px] leading-relaxed text-ink">{children}</div>
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-hairline", className)} />;
}

/**
 * A thin horizontal meter. Used for scorecards, where the number is a writing
 * heuristic rather than a prediction — so the label says so.
 */
export function Meter({
  value,
  max = 10,
  tone = "accent",
}: {
  value: number;
  max?: number;
  tone?: "accent" | "above" | "below";
}) {
  const fraction = Math.max(0, Math.min(1, value / max));
  const color =
    tone === "above"
      ? "var(--color-above)"
      : tone === "below"
        ? "var(--color-below)"
        : "var(--color-accent)";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${fraction * 100}%`, background: color }}
      />
    </div>
  );
}
