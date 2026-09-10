"use client";

import { useState } from "react";
import { compactNumber, multiple, percent } from "@/lib/utils";
import { ConfidenceBadge } from "@/components/ui/status";
import type { Confidence } from "@/generated/prisma/enums";

/**
 * Lift against the project median, as a diverging bar chart.
 *
 * Polarity is the data's job here — "did this beat our own median or not" — so the
 * form is diverging: two hue poles (blue above, red below) around a neutral
 * midpoint at 1.00x. Every bar is directly labelled with its multiple and its
 * sample size, because the sample size is what makes the bar mean anything, and
 * each row carries an explicit confidence badge.
 */

export type LiftGroup = {
  key: string;
  label: string;
  sampleSize: number;
  medianViews: number;
  liftVsMedian: number;
  meanCompletion: number;
  confidence: Confidence;
  confidenceReason: string;
};

export function LiftBars({
  groups,
  baselineMedianViews,
  /** Groups below this are drawn faded: reported, but not actionable. */
  minSample = 3,
}: {
  groups: LiftGroup[];
  baselineMedianViews: number;
  minSample?: number;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (groups.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-[11.5px] text-ink-muted">
        No published posts carry this attribute yet.
      </p>
    );
  }

  // Symmetric scale around 1.0 so a 1.5x bar and a 0.5x bar read as equal
  // distances from the midpoint.
  const maxDeviation = Math.max(
    0.25,
    ...groups.map((group) => Math.abs(group.liftVsMedian - 1)),
  );

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-[10.5px] text-ink-muted">
        <span>Below median</span>
        <span className="tabular">
          median {compactNumber(baselineMedianViews)} views
        </span>
        <span>Above median</span>
      </div>

      <ul className="space-y-1">
        {groups.map((group) => {
          const deviation = group.liftVsMedian - 1;
          const magnitude = Math.min(1, Math.abs(deviation) / maxDeviation);
          const above = deviation >= 0;
          const faded = group.sampleSize < minSample;
          const isOpen = openKey === group.key;

          return (
            <li key={group.key}>
              <button
                type="button"
                onClick={() => setOpenKey(isOpen ? null : group.key)}
                aria-expanded={isOpen}
                className="group grid w-full grid-cols-[minmax(0,9.5rem)_1fr_auto] items-center gap-3 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-surface-raised"
              >
                <span
                  className={`truncate text-[12px] ${faded ? "text-ink-muted" : "text-ink"}`}
                >
                  {group.label}
                </span>

                <span className="relative block h-5">
                  {/* Midpoint: the project's own median. */}
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-1/2 w-px bg-axis"
                  />
                  <span
                    aria-hidden
                    className="absolute top-1/2 h-2.5 -translate-y-1/2"
                    style={{
                      // 4px rounded data-end away from the midpoint; square against it.
                      background: above ? "var(--color-above)" : "var(--color-below)",
                      opacity: faded ? 0.35 : 1,
                      left: above ? "50%" : `calc(50% - ${magnitude * 50}%)`,
                      width: `${magnitude * 50}%`,
                      borderRadius: above ? "0 4px 4px 0" : "4px 0 0 4px",
                    }}
                  />
                </span>

                <span className="flex items-center gap-2.5 justify-self-end">
                  <span
                    className={`w-[3.25rem] text-right text-[11.5px] tabular ${
                      faded ? "text-ink-muted" : "text-ink"
                    }`}
                  >
                    {multiple(group.liftVsMedian)}
                  </span>
                  <span className="w-[3.5rem] text-right text-[10.5px] tabular text-ink-muted">
                    n={group.sampleSize}
                  </span>
                </span>
              </button>

              {isOpen ? (
                <div className="animate-fade-up mb-1 ml-1 mr-1 rounded-md border border-hairline bg-surface-raised px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <ConfidenceBadge
                      confidence={group.confidence}
                      reason={group.confidenceReason}
                    />
                    <span className="text-[11px] tabular text-ink-secondary">
                      {compactNumber(group.medianViews)} median views
                    </span>
                    <span className="text-[11px] tabular text-ink-secondary">
                      {percent(group.meanCompletion, 0)} mean completion
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-muted">
                    {group.confidenceReason}
                  </p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="mt-2.5 border-t border-hairline pt-2 text-[10.5px] leading-relaxed text-ink-muted">
        Compared against this project&rsquo;s own median, never an external
        benchmark. Faded rows have fewer than {minSample} posts and are shown for
        completeness only. Select a row for the confidence reasoning.
      </p>
    </div>
  );
}

/**
 * The table view every chart owes its reader: same numbers, no colour required.
 */
export function LiftTable({ groups }: { groups: LiftGroup[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[30rem] text-left text-[11.5px]">
        <thead>
          <tr className="border-b border-hairline text-[10.5px] uppercase tracking-wider text-ink-muted">
            <th scope="col" className="px-4 py-2 font-semibold">Group</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Posts</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Median views</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Lift</th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">Completion</th>
            <th scope="col" className="px-4 py-2 font-semibold">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.key} className="border-b border-hairline/60 last:border-0">
              <td className="px-4 py-2 text-ink">{group.label}</td>
              <td className="px-3 py-2 text-right tabular text-ink-secondary">
                {group.sampleSize}
              </td>
              <td className="px-3 py-2 text-right tabular text-ink-secondary">
                {group.medianViews.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right tabular text-ink">
                {multiple(group.liftVsMedian)}
              </td>
              <td className="px-3 py-2 text-right tabular text-ink-secondary">
                {percent(group.meanCompletion, 0)}
              </td>
              <td className="px-4 py-2">
                <ConfidenceBadge
                  confidence={group.confidence}
                  reason={group.confidenceReason}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
