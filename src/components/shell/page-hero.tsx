import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Decorative summit ridge from the reference art, redrawn as a light inline SVG
 * rather than shipping stock photography. Kept low-contrast so it never
 * competes with the content.
 */
function SummitMotif() {
  return (
    <svg
      viewBox="0 0 320 150"
      className="h-full w-full"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <defs>
        <linearGradient id="ss-hero-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0d2733" />
          <stop offset="100%" stopColor="#060a11" />
        </linearGradient>
        <linearGradient id="ss-hero-ridge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.1" />
          <stop offset="55%" stopColor="#22d3ee" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.12" />
        </linearGradient>
      </defs>
      <rect width="320" height="150" fill="url(#ss-hero-sky)" />
      <path d="M0 150 L64 74 L104 104 L152 46 L206 100 L252 66 L320 150 Z" fill="#0a1620" opacity="0.95" />
      <path d="M0 150 L48 104 L96 128 L146 88 L196 126 L248 98 L320 150 Z" fill="#0c1c27" opacity="0.9" />
      <path
        d="M32 148 C70 128 76 112 108 104 C136 97 140 82 152 48"
        fill="none"
        stroke="url(#ss-hero-ridge)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="152" cy="44" r="2.6" fill="#22d3ee" />
      <circle cx="152" cy="44" r="8" fill="#22d3ee" opacity="0.2" />
    </svg>
  );
}

export function PageHero({
  title,
  accentWord,
  subtitle,
  kicker,
  actions,
  className,
}: {
  title: string;
  accentWord?: string;
  subtitle: string;
  kicker?: string[];
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-[var(--radius-panel)] border border-hairline bg-surface/70",
        className,
      )}
    >
      <div className="pointer-events-none absolute inset-y-0 right-0 hidden w-[44%] md:block" aria-hidden>
        <SummitMotif />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,var(--color-surface)_0%,rgba(10,15,24,0.7)_38%,transparent_100%)]" />
      </div>

      <div className="relative flex flex-col gap-4 px-5 py-6 md:px-7 md:py-8 lg:max-w-[62%]">
        <div>
          <h1 className="text-[30px] leading-[1.1] font-bold tracking-tight text-ink md:text-[38px]">
            {title}
            {accentWord ? <span className="text-accent"> {accentWord}</span> : null}
          </h1>
          <p className="mt-2 max-w-xl text-[14px] text-ink-muted md:text-[15px]">{subtitle}</p>
        </div>

        {kicker?.length ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] tracking-[0.2em] text-ink-faint">
            {kicker.map((word, i) => (
              <React.Fragment key={word}>
                {i > 0 ? <span className="text-hairline-strong">/</span> : null}
                <span>{word.toUpperCase()}</span>
              </React.Fragment>
            ))}
          </p>
        ) : null}

        {actions ? <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div> : null}
      </div>
    </section>
  );
}
