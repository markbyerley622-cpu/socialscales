/**
 * Social Scales UI primitives.
 *
 * One card system, one button system, one badge system. Everything else in the
 * app composes from here so radii, borders and spacing stay consistent.
 */

import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Panel + Card                                                               */
/* -------------------------------------------------------------------------- */

export function Panel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      className={cn(
        "rounded-[var(--radius-panel)] border border-hairline bg-surface/80 backdrop-blur-[2px]",
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  eyebrow,
  title,
  description,
  action,
  className,
}: {
  eyebrow?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3", className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="ss-eyebrow">{eyebrow}</p> : null}
        {title ? <h2 className="mt-1 text-[15px] font-semibold text-ink">{title}</h2> : null}
        {description ? <p className="mt-1 text-[13px] text-ink-muted">{description}</p> : null}
      </div>
      {/* Must be allowed to shrink: some actions hold a scrollable tab strip. */}
      {action ? <div className="flex min-w-0 max-w-full items-center gap-2">{action}</div> : null}
    </header>
  );
}

export function PanelBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("px-5 pb-5", className)}>{children}</div>;
}

export function Card({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] border border-hairline bg-surface-2/70 p-4",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-hairline", className)} />;
}

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-[#04121a] font-semibold hover:bg-accent-soft shadow-[0_0_0_1px_rgba(34,211,238,0.35),0_8px_24px_-12px_rgba(34,211,238,0.7)]",
  secondary: "bg-surface-3 text-ink border border-hairline-strong hover:border-accent/40 hover:text-white",
  ghost: "text-ink-muted hover:text-ink hover:bg-white/5",
  danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/22",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[12px] gap-1.5",
  md: "h-9 px-4 text-[13px] gap-2",
  lg: "h-11 px-5 text-[14px] gap-2",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-control)] whitespace-nowrap transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-inherit",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
});

/**
 * Navigation that should look like a button. Kept separate from `Button` so we
 * never nest an anchor inside a button element.
 */
export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  className,
  children,
  ...props
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<typeof Link>, "href" | "className" | "children">) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-control)] whitespace-nowrap transition-colors",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {children}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* Badges                                                                     */
/* -------------------------------------------------------------------------- */

export function Badge({
  className,
  children,
  dot,
}: {
  className?: string;
  children: React.ReactNode;
  dot?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[11px] font-medium whitespace-nowrap",
        className,
      )}
    >
      {dot ? <span className={cn("size-1.5 rounded-full", dot)} /> : null}
      {children}
    </span>
  );
}

export function DemoDataBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-warn/30 bg-warn/10 px-2.5 py-[3px] text-[11px] font-medium text-warn",
        className,
      )}
      title="Values on this screen come from the local development fixture set, not from a live account."
    >
      <span className="size-1.5 rounded-full bg-warn" />
      Demo dataset
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Form controls                                                              */
/* -------------------------------------------------------------------------- */

const FIELD_BASE =
  "w-full rounded-[var(--radius-control)] border border-hairline-strong bg-surface-3/60 px-3 text-[13px] text-ink placeholder:text-ink-faint transition-colors focus:border-accent/60 focus:bg-surface-3 disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(FIELD_BASE, "h-10", className)} {...props} />;
  },
);

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(FIELD_BASE, "py-2.5 leading-relaxed", className)} {...props} />;
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(FIELD_BASE, "h-10 appearance-none pr-8", className)} {...props}>
      {children}
    </select>
  );
});

export function Field({
  label,
  hint,
  required,
  counter,
  children,
  className,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  counter?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">
          {label}
          {required ? <span className="ml-1 text-accent">*</span> : null}
        </span>
        {counter ? <span className="text-[11px] text-ink-faint">{counter}</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1.5 block text-[11px] text-ink-faint">{hint}</span> : null}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

export function Progress({
  value,
  className,
  barClassName,
  indeterminate,
}: {
  value?: number;
  className?: string;
  barClassName?: string;
  indeterminate?: boolean;
}) {
  return (
    <div
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-white/8", className, indeterminate && "ss-indeterminate")}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {indeterminate ? null : (
        <div
          className={cn("h-full rounded-full bg-accent transition-[width] duration-500", barClassName)}
          style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-hairline-strong bg-surface-2/40 px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? <div className="mb-3 text-ink-faint">{icon}</div> : null}
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {description ? <p className="mt-1.5 max-w-sm text-[13px] text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-danger/30 bg-danger/8 px-5 py-6">
      <p className="text-[14px] font-semibold text-danger">{title}</p>
      {detail ? <p className="mt-1.5 text-[13px] text-ink-muted">{detail}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-[var(--radius-control)] bg-white/6", className)} />;
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

export function Avatar({ initials, className }: { initials: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-accent/25 bg-accent/10 text-[12px] font-semibold tracking-wide text-accent",
        className,
      )}
    >
      {initials}
    </span>
  );
}

export function DeltaPill({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-[11px] text-ink-faint">No baseline yet</span>;
  }
  const positive = value >= 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-medium",
        positive ? "text-ok" : "text-danger",
      )}
    >
      <span aria-hidden>{positive ? "▲" : "▼"}</span>
      {positive ? "+" : ""}
      {value}%
    </span>
  );
}
