"use client";

import { Ban, Clapperboard, Film, RotateCcw, TriangleAlert } from "lucide-react";
import { cancelRenderAction, renderVariantAction } from "@/app/actions/posts";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import { Badge, SectionLabel } from "@/components/ui/primitives";
import type { BadgeTone } from "@/components/ui/primitives";
import { bytes, duration } from "@/lib/utils";

/**
 * The rendered cut for one variant: its state, and the file itself.
 *
 * A render is the first thing in this system that produces something an
 * operator has to *watch* rather than read, so the finished file is playable in
 * place. Anything else — a status that says "done" with no way to see the
 * result — asks them to trust a green tick.
 */

export type RenderView = {
  id: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  stage: string;
  progress: number;
  attempts: number;
  durationMs: number | null;
  errorKind: string | null;
  error: string | null;
  failureStage: string | null;
  logExcerpt: string | null;
  provider: string | null;
  output: {
    storageKey: string;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    sizeBytes: number;
  } | null;
};

export function RenderPanel({
  variantId,
  render,
  canRender,
  blockedReason,
}: {
  variantId: string;
  render: RenderView | null;
  canRender: boolean;
  blockedReason: string | null;
}) {
  const busy = render?.status === "PENDING" || render?.status === "RUNNING";

  return (
    <div className="border-t border-hairline pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SectionLabel>Rendered cut</SectionLabel>
          {render ? <Badge tone={toneFor(render.status)}>{render.status}</Badge> : null}
          {render && busy ? (
            <span className="text-[10.5px] tabular text-ink-muted">
              {render.stage.toLowerCase()} · {render.progress}%
            </span>
          ) : null}
          {render?.attempts && render.attempts > 1 ? (
            <span className="text-[10.5px] tabular text-ink-muted">
              attempt {render.attempts}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {busy ? (
            <ActionForm action={cancelRenderAction}>
              <input type="hidden" name="renderJobId" value={render!.id} />
              <SubmitButton variant="ghost" size="sm" pendingLabel="Cancelling…">
                <Ban />
                Cancel
              </SubmitButton>
            </ActionForm>
          ) : (
            <ActionForm action={renderVariantAction}>
              <input type="hidden" name="variantId" value={variantId} />
              {render?.status === "SUCCEEDED" ? (
                <input type="hidden" name="force" value="1" />
              ) : null}
              <SubmitButton
                variant="ghost"
                size="sm"
                pendingLabel="Queueing…"
                disabled={!canRender}
                title={blockedReason ?? undefined}
              >
                {render?.status === "SUCCEEDED" ? <RotateCcw /> : <Clapperboard />}
                {render?.status === "SUCCEEDED" ? "Render again" : "Render"}
              </SubmitButton>
            </ActionForm>
          )}
        </div>
      </div>

      {busy ? (
        <div
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-raised"
          role="progressbar"
          aria-valuenow={render!.progress}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Render progress"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${Math.max(2, render!.progress)}%` }}
          />
        </div>
      ) : null}

      {!canRender && blockedReason ? (
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-muted">
          {blockedReason}
        </p>
      ) : null}

      {render?.status === "SUCCEEDED" && render.output ? (
        <div className="mt-2.5 space-y-2">
          {/* Serving through the media route means the same session check that
              protects an upload also protects the cut. */}
          <video
            controls
            preload="metadata"
            playsInline
            src={`/api/media/${render.output.storageKey}`}
            className="w-full max-w-[240px] rounded-md border border-hairline bg-black"
          />
          <p className="text-[10.5px] tabular text-ink-muted">
            {render.output.width}×{render.output.height}
            {render.output.durationSeconds
              ? ` · ${duration(render.output.durationSeconds)}`
              : ""}{" "}
            · {bytes(render.output.sizeBytes)}
            {render.durationMs ? ` · rendered in ${(render.durationMs / 1000).toFixed(1)}s` : ""}
            {render.provider ? ` · ${render.provider}` : ""}
          </p>
        </div>
      ) : null}

      {render?.status === "FAILED" ? (
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="critical" icon={<TriangleAlert />}>
              {render.errorKind ?? "FAILED"}
            </Badge>
            {render.failureStage ? (
              <span className="text-[10.5px] text-ink-muted">
                at {render.failureStage.toLowerCase()}
              </span>
            ) : null}
          </div>
          <p className="text-[11px] leading-relaxed text-ink-secondary">{render.error}</p>
          {render.logExcerpt ? (
            <details className="text-[10.5px] text-ink-muted">
              <summary className="cursor-pointer">Encoder output</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-surface-raised p-2 text-[10px] leading-relaxed">
                {render.logExcerpt}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {!render ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[10.5px] leading-relaxed text-ink-muted">
          <Film className="size-3 shrink-0" />
          Not rendered. The treatment describes the cut; rendering produces the
          actual vertical MP4 that gets published.
        </p>
      ) : null}
    </div>
  );
}

function toneFor(status: RenderView["status"]): BadgeTone {
  if (status === "SUCCEEDED") return "good";
  if (status === "FAILED") return "critical";
  if (status === "RUNNING") return "accent";
  if (status === "CANCELLED") return "neutral";
  return "warning";
}
