import type { Metadata } from "next";
import { Target } from "lucide-react";

import { PageHero } from "@/components/shell/page-hero";
import { PlatformChip, StatusBadge } from "@/components/ui/data-display";
import {
  Badge,
  EmptyState,
  LinkButton,
  Panel,
  PanelBody,
  PanelHeader,
  Progress,
} from "@/components/ui/primitives";
import { PlanActions } from "@/features/plan/plan-actions";
import { PILLAR_BAR, PILLAR_COLOR } from "@/lib/display";
import { getAdapter } from "@/lib/social-scales";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Plan" };

const PLAN_STATUS_STYLE = {
  DRAFT: "border-hairline bg-white/6 text-ink-muted",
  AWAITING_APPROVAL: "border-warn/28 bg-warn/10 text-warn",
  ACTIVE: "border-ok/25 bg-ok/10 text-ok",
  COMPLETED: "border-hairline bg-white/6 text-ink-muted",
} as const;

export default async function PlanPage() {
  const adapter = getAdapter();
  const [plan, history] = await Promise.all([adapter.getActivePlan(), adapter.getPlanHistory()]);

  if (!plan) {
    return (
      <div className="flex flex-col gap-5">
        <PageHero
          title="Content"
          accentWord="plan"
          subtitle="The weekly strategy the whole system produces against."
          kicker={["Objective", "Pillars", "Cadence", "Briefs"]}
        />
        <Panel>
          <PanelBody className="pt-5">
            <EmptyState
              icon={<Target className="size-6" />}
              title="No plan has been generated yet"
              description="Finish onboarding so the system has enough business context to build the first weekly plan."
              action={<LinkButton href="/onboarding" variant="primary" size="sm">Run onboarding</LinkButton>}
            />
          </PanelBody>
        </Panel>
      </div>
    );
  }

  const byDay = plan.briefs.reduce<Record<string, typeof plan.briefs>>((acc, brief) => {
    (acc[brief.dayLabel] ??= []).push(brief);
    return acc;
  }, {});
  const dayOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const shipped = plan.briefs.filter((b) => b.status === "PUBLISHED").length;

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="This week's"
        accentWord="plan"
        subtitle={plan.objective}
        kicker={["Objective", "Pillars", "Cadence", "Briefs"]}
        actions={<PlanActions planId={plan.id} status={plan.status} />}
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="flex flex-col gap-5 xl:col-span-8">
          {/* Briefs */}
          <Panel>
            <PanelHeader
              eyebrow="Weekly briefs"
              title={`${plan.briefs.length} briefs planned`}
              description={plan.cadence}
              action={
                <Badge className={PLAN_STATUS_STYLE[plan.status]}>
                  {plan.status === "AWAITING_APPROVAL" ? "Awaiting approval" : plan.status.charAt(0) + plan.status.slice(1).toLowerCase()}
                </Badge>
              }
            />
            <PanelBody>
              <div className="flex flex-col gap-3">
                {dayOrder
                  .filter((day) => byDay[day]?.length)
                  .map((day) => (
                    <div key={day} className="flex flex-col gap-2 sm:flex-row sm:gap-4">
                      <p className="w-16 shrink-0 pt-2 text-[12px] font-semibold tracking-wider text-ink-faint uppercase">
                        {day}
                      </p>
                      <ul className="flex min-w-0 flex-1 flex-col gap-2">
                        {byDay[day].map((brief) => {
                          const pillar = plan.pillars.find((p) => p.id === brief.pillarId);
                          return (
                            <li
                              key={brief.id}
                              className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-card)] border border-hairline bg-surface-2/55 px-4 py-3"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <PlatformChip platform={brief.platform} />
                                  {pillar ? (
                                    <span
                                      className={cn(
                                        "rounded-full border px-2 py-0.5 text-[10.5px]",
                                        PILLAR_COLOR[pillar.colorToken],
                                      )}
                                    >
                                      {pillar.name}
                                    </span>
                                  ) : null}
                                  <span className="text-[11px] text-ink-faint">
                                    {new Date(brief.scheduledFor).toLocaleTimeString("en-GB", {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </div>
                                <p className="mt-1.5 text-[13.5px] font-medium text-ink">{brief.title}</p>
                                <p className="mt-0.5 text-[12px] text-ink-muted">{brief.angle}</p>
                              </div>
                              <StatusBadge status={brief.status} />
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
              </div>
            </PanelBody>
          </Panel>

          {/* History */}
          <Panel>
            <PanelHeader eyebrow="Plan history" title="Previous weeks" description="Adherence is the share of planned briefs that actually shipped." />
            <PanelBody>
              <div className="ss-scrollbar overflow-x-auto">
                <table className="w-full min-w-[560px] text-left">
                  <thead>
                    <tr className="border-b border-hairline">
                      {["Week", "Period", "Published", "Adherence", "Headline"].map((h) => (
                        <th key={h} className="ss-eyebrow pb-2.5 font-semibold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((entry) => (
                      <tr key={entry.id} className="border-b border-hairline last:border-b-0">
                        <td className="py-3 text-[13px] font-medium text-ink">{entry.label}</td>
                        <td className="py-3 text-[12.5px] whitespace-nowrap text-ink-muted">
                          {new Date(entry.periodStart).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} –{" "}
                          {new Date(entry.periodEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                        </td>
                        <td className="py-3 text-[13px] text-ink tabular-nums">{entry.postsPublished}</td>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <Progress value={entry.adherencePct} className="w-20" />
                            <span className="text-[12.5px] text-ink tabular-nums">{entry.adherencePct}%</span>
                          </div>
                        </td>
                        <td className="py-3 text-[12.5px] text-ink-muted">{entry.headline}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </PanelBody>
          </Panel>
        </div>

        <div className="flex flex-col gap-5 xl:col-span-4">
          {/* Objective */}
          <Panel>
            <PanelHeader eyebrow="Objective" title={plan.label} />
            <PanelBody>
              <p className="text-[13px] leading-relaxed text-ink-muted">{plan.objective}</p>

              <div className="mt-4 border-t border-hairline pt-4">
                <p className="ss-eyebrow">Audience</p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">{plan.audienceSummary}</p>
              </div>

              <div className="mt-4 border-t border-hairline pt-4">
                <p className="ss-eyebrow">Cadence</p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">{plan.cadence}</p>
              </div>

              <div className="mt-4 border-t border-hairline pt-4">
                <div className="flex items-center justify-between text-[12px]">
                  <span className="text-ink-muted">
                    Adherence · {shipped} of {plan.briefs.length} shipped
                  </span>
                  <span className="font-semibold text-ink tabular-nums">{plan.adherencePct}%</span>
                </div>
                <Progress value={plan.adherencePct} className="mt-2" />
              </div>
            </PanelBody>
          </Panel>

          {/* Pillars */}
          <Panel>
            <PanelHeader eyebrow="Content pillars" title="What this week is about" />
            <PanelBody>
              <ul className="flex flex-col gap-3">
                {plan.pillars.map((pillar) => (
                  <li key={pillar.id}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", PILLAR_COLOR[pillar.colorToken])}>
                        {pillar.name}
                      </span>
                      <span className="text-[12px] text-ink-muted tabular-nums">{pillar.sharePct}%</span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/8">
                      <div
                        className={cn("h-full rounded-full", PILLAR_BAR[pillar.colorToken])}
                        style={{ width: `${pillar.sharePct}%` }}
                      />
                    </div>
                    <p className="mt-1.5 text-[12px] leading-snug text-ink-muted">{pillar.description}</p>
                  </li>
                ))}
              </ul>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </div>
  );
}
