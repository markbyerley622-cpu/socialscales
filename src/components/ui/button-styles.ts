import { cn } from "@/lib/utils";

/**
 * Button styling, deliberately in its own module with no "use client".
 *
 * `buttonClass` is a pure string function, and server components use it to make
 * a <Link> look like a button. Exporting it from the client-side button module
 * would put it behind the client boundary, where a server component calling it
 * is a runtime error rather than a type error.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-[#0d0b1c] hover:bg-accent-ink font-semibold disabled:bg-accent/40 disabled:text-[#0d0b1c]/60",
  secondary:
    "border border-hairline-strong bg-surface-raised text-ink hover:bg-surface-hover",
  ghost: "text-ink-secondary hover:bg-surface-raised hover:text-ink",
  danger:
    "border border-critical/45 bg-critical/12 text-[#ec7d7d] hover:bg-critical/20",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[11.5px] gap-1.5",
  md: "h-8 px-3 text-[12px] gap-2",
};

export function buttonClass(
  variant: ButtonVariant = "secondary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return cn(
    "inline-flex items-center justify-center rounded-md font-medium",
    "transition-colors duration-150 select-none",
    "disabled:cursor-not-allowed disabled:opacity-60",
    "[&>svg]:size-3.5 [&>svg]:shrink-0",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}
