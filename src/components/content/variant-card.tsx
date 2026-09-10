"use client";

import { useState } from "react";
import { Pencil, Save, X } from "lucide-react";
import { updateVariantAction } from "@/app/actions/posts";
import { ActionForm } from "@/components/ui/action-form";
import { Button, SubmitButton } from "@/components/ui/button";
import { Badge, Meter, SectionLabel } from "@/components/ui/primitives";
import { ConfidenceBadge } from "@/components/ui/status";
import { multiple } from "@/lib/utils";
import type { Confidence } from "@/generated/prisma/enums";

/**
 * One copy variant: the drafted hook, caption, hashtags and CTA, its writing
 * scorecard, and the evidence-based performance estimate for this combination.
 *
 * The two numbers are deliberately kept apart and labelled differently. The
 * scorecard is a writing heuristic with no predictive claim. The estimate is
 * derived from this project's own published results and carries a confidence.
 */

export type Scorecard = {
  hook: number;
  clarity: number;
  curiosity: number;
  cta: number;
  trendRelevance: number;
  notes: string[];
};

export type VariantEstimate = {
  expectedLift: number;
  expectedViews: number;
  confidence: Confidence;
  explanation: string;
  basis: Array<{
    dimension: string;
    group: string;
    lift: number;
    sampleSize: number;
    confidence: Confidence;
  }>;
};

export function VariantCard({
  variantId,
  assetId,
  label,
  hook,
  caption,
  hashtags,
  cta,
  isControl,
  scorecard,
  estimate,
  usedInPosts,
}: {
  variantId: string;
  assetId: string;
  label: string;
  hook: string;
  caption: string;
  hashtags: string[];
  cta: string;
  isControl: boolean;
  scorecard: Scorecard | null;
  estimate: VariantEstimate | null;
  usedInPosts: number;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="rounded-[10px] border border-hairline bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-hairline px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">{label}</Badge>
          {isControl ? <Badge tone="accent">Control</Badge> : null}
          {usedInPosts > 0 ? (
            <span className="text-[10.5px] tabular text-ink-muted">
              used in {usedInPosts} post{usedInPosts === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setEditing((current) => !current)}
        >
          {editing ? <X /> : <Pencil />}
          {editing ? "Cancel" : "Edit"}
        </Button>
      </div>

      {editing ? (
        <ActionForm
          action={updateVariantAction}
          className="space-y-2.5 px-3.5 py-3"
        >
          <input type="hidden" name="variantId" value={variantId} />
          <input type="hidden" name="assetId" value={assetId} />
          <input type="hidden" name="label" value={label} />

          <Labelled label="Hook">
            <input
              name="hook"
              defaultValue={hook}
              required
              className="w-full rounded-md border border-hairline-strong bg-surface-raised px-2 py-1.5 text-[12.5px] text-ink"
            />
          </Labelled>
          <Labelled label="Caption">
            <textarea
              name="caption"
              defaultValue={caption}
              required
              rows={4}
              className="w-full resize-y rounded-md border border-hairline-strong bg-surface-raised px-2 py-1.5 text-[12.5px] leading-relaxed text-ink"
            />
          </Labelled>
          <Labelled label="Hashtags">
            <input
              name="hashtags"
              defaultValue={hashtags.join(" ")}
              className="w-full rounded-md border border-hairline-strong bg-surface-raised px-2 py-1.5 text-[12.5px] text-ink"
            />
          </Labelled>
          <Labelled label="Call to action">
            <input
              name="cta"
              defaultValue={cta}
              className="w-full rounded-md border border-hairline-strong bg-surface-raised px-2 py-1.5 text-[12.5px] text-ink"
            />
          </Labelled>

          <SubmitButton size="sm" pendingLabel="Saving…">
            <Save />
            Save and re-score
          </SubmitButton>
        </ActionForm>
      ) : (
        <div className="space-y-3 px-3.5 py-3">
          <p className="text-[13.5px] font-medium leading-snug text-ink">{hook}</p>
          <p className="whitespace-pre-line text-[12px] leading-relaxed text-ink-secondary">
            {caption}
          </p>
          {hashtags.length > 0 ? (
            <p className="text-[11.5px] leading-relaxed text-accent-ink">
              {hashtags.join(" ")}
            </p>
          ) : null}
          {cta ? (
            <p className="text-[11.5px] text-ink-muted">
              <span className="uppercase tracking-wider">CTA</span> · {cta}
            </p>
          ) : null}

          <div className="grid gap-3 border-t border-hairline pt-3 sm:grid-cols-2">
            {scorecard ? (
              <div>
                <SectionLabel>Writing heuristics · not a prediction</SectionLabel>
                <dl className="mt-2 space-y-1.5">
                  <Score label="Hook" value={scorecard.hook} />
                  <Score label="Clarity" value={scorecard.clarity} />
                  <Score label="Curiosity" value={scorecard.curiosity} />
                  <Score label="CTA" value={scorecard.cta} />
                  <Score label="Trend fit" value={scorecard.trendRelevance} />
                </dl>
                {scorecard.notes.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {scorecard.notes.map((note, index) => (
                      <li key={index} className="text-[10.5px] leading-relaxed text-ink-muted">
                        · {note}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {estimate ? (
              <div>
                <SectionLabel>Performance estimate</SectionLabel>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <span className="text-[20px] font-semibold leading-none tracking-tight text-ink">
                    {multiple(estimate.expectedLift)}
                  </span>
                  <span className="text-[11px] text-ink-muted">
                    ≈ {estimate.expectedViews.toLocaleString()} views
                  </span>
                </div>
                <div className="mt-2">
                  <ConfidenceBadge
                    confidence={estimate.confidence}
                    reason={estimate.explanation}
                  />
                </div>
                <p className="mt-2 text-[10.5px] leading-relaxed text-ink-muted">
                  {estimate.explanation}
                </p>
                {estimate.basis.length > 0 ? (
                  <ul className="mt-2 space-y-0.5">
                    {estimate.basis.map((entry, index) => (
                      <li
                        key={index}
                        className="flex items-baseline justify-between gap-2 text-[10.5px]"
                      >
                        <span className="truncate text-ink-muted">
                          {entry.dimension}: {entry.group}
                        </span>
                        <span className="shrink-0 tabular text-ink-secondary">
                          {multiple(entry.lift)} · n={entry.sampleSize}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function Score({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <dt className="w-[4.75rem] shrink-0 text-[10.5px] text-ink-muted">{label}</dt>
      <dd className="flex flex-1 items-center gap-2">
        <Meter value={value} />
        <span className="w-7 shrink-0 text-right text-[10.5px] tabular text-ink-secondary">
          {value.toFixed(1)}
        </span>
      </dd>
    </div>
  );
}

function Labelled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <div className="mt-1">{children}</div>
    </div>
  );
}
