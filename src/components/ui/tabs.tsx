"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export interface TabItem<T extends string = string> {
  value: T;
  label: string;
  count?: number;
}

/**
 * Segmented control used for the queue tabs, calendar mode switch and analytics
 * series switch. Keyboard-navigable with arrow keys, per WAI-ARIA tabs.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  size = "md",
  className,
  ariaLabel,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
  ariaLabel: string;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = items.findIndex((item) => item.value === value);
    if (index < 0) return;

    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;

    event.preventDefault();
    onChange(items[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        "ss-scrollbar inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-[var(--radius-control)] border border-hairline bg-surface-2/60 p-1",
        className,
      )}
    >
      {items.map((item, i) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.value)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md whitespace-nowrap transition-colors",
              size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
              active
                ? "bg-accent/14 font-medium text-accent shadow-[inset_0_0_0_1px_rgba(34,211,238,0.28)]"
                : "text-ink-muted hover:bg-white/5 hover:text-ink",
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <span
                className={cn(
                  "rounded px-1 text-[10px] tabular-nums",
                  active ? "bg-accent/20 text-accent" : "bg-white/8 text-ink-faint",
                )}
              >
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
