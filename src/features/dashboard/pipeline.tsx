import { BarChart3, FileText, Lightbulb, Send, Target, Video } from "lucide-react";

import { Panel, PanelBody, PanelHeader } from "@/components/ui/primitives";
import type { PipelineStage } from "@/lib/social-scales/contracts";

const STAGE_ICONS = {
  PLAN: Target,
  IDEAS: Lightbulb,
  SCRIPTS: FileText,
  CONTENT: Video,
  PUBLISH: Send,
  LEARN: BarChart3,
} as const;

/**
 * The product's spine: plan -> ideas -> scripts -> content -> publish -> learn.
 * Counts come from the live queue, so this doubles as a status read-out.
 */
export function PipelinePanel({ stages }: { stages: PipelineStage[] }) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="The content pipeline"
        title="From business context to results, on a loop"
        description="Every stage is a real queue. The number is what is sitting in it right now."
      />
      <PanelBody>
        <ol className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
          {stages.map((stage, index) => {
            const Icon = STAGE_ICONS[stage.key];
            return (
              <li
                key={stage.key}
                className="relative rounded-[var(--radius-card)] border border-hairline bg-surface-2/60 p-3.5"
              >
                <div className="flex items-center justify-between">
                  <span className="inline-flex size-9 items-center justify-center rounded-lg border border-accent/22 bg-accent/8 text-accent">
                    <Icon className="size-[18px]" />
                  </span>
                  <span className="text-[18px] leading-none font-semibold text-ink tabular-nums">{stage.count}</span>
                </div>
                <p className="mt-3 text-[12.5px] font-medium text-ink">
                  <span className="text-ink-faint">{index + 1}. </span>
                  {stage.label}
                </p>
                <p className="mt-1 text-[11.5px] leading-snug text-ink-muted">{stage.description}</p>
              </li>
            );
          })}
        </ol>
      </PanelBody>
    </Panel>
  );
}
