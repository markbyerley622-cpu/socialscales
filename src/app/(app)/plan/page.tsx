import type { Metadata } from "next";
import { CalendarRange, FlaskConical, SkipForward } from "lucide-react";
import { prisma } from "@/server/db";
import { activePlan, planAdherence, planHistory } from "@/server/content-director";
import { createPlanAction, skipBriefAction } from "@/app/actions/operations";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import type { BadgeTone } from "@/components/ui/primitives";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  KeyValue,
  ProjectDot,
  SectionLabel,
} from "@/components/ui/primitives";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import { dateTimeLabel } from "@/lib/utils";
import { BriefStatus, ContentPlanStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Plan" };
export const dynamic = "force-dynamic";

/**
 * The plan screen.
 *
 * Two things it must show that a calendar cannot: which strategy decision each
 * brief serves, and planned mix against delivered mix. A plan that says half
 * screen recordings against a feed that is nine tenths talking heads is a real
 * finding, and it is invisible unless both numbers are on the same page.
 */
export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const params = await searchParams;
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, slug: true, name: true, accentColor: true },
  });

  if (projects.length === 0) {
    return (
      <>
        <PageHeader title="Plan" description="What each brand will publish, and why." />
        <PageBody>
          <Card>
            <EmptyState
              icon={<CalendarRange />}
              title="No projects yet"
              body="A plan is written for one brand. Create a project first."
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const selected =
    projects.find((project) => project.slug === params.project) ?? projects[0]!;

  const [plan, history] = await Promise.all([
    activePlan(selected.id),
    planHistory(selected.id),
  ]);
  const adherence = plan ? await planAdherence(plan.id) : null;

  return (
    <>
      <PageHeader
        title="Plan"
        description="Concrete briefs derived from the active strategy. Each one names the decision it serves, so a published post traces back to the evidence that argued for it."
        actions={
          <ActionForm action={createPlanAction} className="flex items-center gap-2">
            <input type="hidden" name="projectId" value={selected.id} />
            <input type="hidden" name="days" value="14" />
            <SubmitButton pendingLabel="Planning…">
              {plan ? "Replan the next 14 days" : "Plan the next 14 days"}
            </SubmitButton>
          </ActionForm>
        }
      />

      <PageBody className="space-y-4">
        {projects.length > 1 ? (
          <nav className="flex flex-wrap items-center gap-1.5" aria-label="Project">
            {projects.map((project) => (
              <a
                key={project.id}
                href={`/plan?project=${project.slug}`}
                aria-current={project.id === selected.id ? "page" : undefined}
                className={
                  project.id === selected.id
                    ? "inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-raised px-2.5 py-1 text-[11.5px] text-ink"
                    : "inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-[11.5px] text-ink-muted hover:bg-surface-raised/70 hover:text-ink"
                }
              >
                <ProjectDot color={project.accentColor} />
                {project.name}
              </a>
            ))}
          </nav>
        ) : null}

        {!plan ? (
          <Card>
            <EmptyState
              icon={<CalendarRange />}
              title="No active plan for this brand"
              body="A plan implements the active strategy. If there is no strategy yet, draft one first — a plan without a strategy is just a list."
            />
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader
                title={`Plan v${plan.version} · ${plan.briefs.length} briefs`}
                subtitle={`${dateLabel(plan.startsOn)} to ${dateLabel(plan.endsOn)} · implements strategy v${plan.strategy.version} (${plan.strategy.confidence} confidence) · ${plan.generatedBy}${plan.model ? ` (${plan.model})` : " — rules, no language model"}`}
              />
              <div className="space-y-4 px-4 py-4">
                <p className="text-[13px] leading-relaxed text-ink">{plan.summary}</p>
                {gaps(plan.rationale).length > 0 ? (
                  <div>
                    <SectionLabel>What this plan does not cover</SectionLabel>
                    <ul className="mt-1 space-y-1">
                      {gaps(plan.rationale).map((gap, index) => (
                        <li key={index} className="text-[11.5px] leading-relaxed text-ink-muted">
                          {gap}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </Card>

            {adherence ? (
              <Card>
                <CardHeader
                  title="Planned against delivered"
                  subtitle="Intent is not delivery. Delivered counts only briefs a post was actually made from."
                />
                <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
                  <KeyValue label="Fulfilled">
                    {adherence.fulfilled} of {adherence.planned.total}
                  </KeyValue>
                  <KeyValue label="Outstanding">
                    {adherence.outstanding}
                    {adherence.overdue > 0 ? ` (${adherence.overdue} past their date)` : ""}
                  </KeyValue>
                  <KeyValue label="Skipped">{adherence.skipped}</KeyValue>
                  <KeyValue label="Experiments planned">
                    {adherence.planned.experiments} · delivered{" "}
                    {adherence.delivered.experiments}
                  </KeyValue>
                </div>
                <div className="grid gap-4 border-t border-hairline px-4 py-4 sm:grid-cols-3">
                  <MixColumn
                    label="Formats"
                    planned={adherence.planned.formats}
                    delivered={adherence.delivered.formats}
                  />
                  <MixColumn
                    label="Pillars"
                    planned={adherence.planned.pillars}
                    delivered={adherence.delivered.pillars}
                  />
                  <MixColumn
                    label="Hook families"
                    planned={adherence.planned.hookFamilies}
                    delivered={adherence.delivered.hookFamilies}
                  />
                </div>
              </Card>
            ) : null}

            <Card>
              <CardHeader
                title="Briefs"
                subtitle="Each one names the strategy decision it serves. A skipped brief keeps its reason — the record of what was not made matters too."
              />
              <ul className="divide-y divide-hairline">
                {plan.briefs.map((brief) => (
                  <li key={brief.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="tabular text-[11px] text-ink-muted">
                            #{brief.sequence}
                          </span>
                          <p className="text-[12.5px] font-medium text-ink">
                            {brief.workingTitle}
                          </p>
                          <Badge tone={briefTone(brief.status)}>{brief.status}</Badge>
                          {brief.isExperiment ? (
                            <Badge tone="accent" icon={<FlaskConical />}>
                              Test of hypothesis {(brief.hypothesisIndex ?? 0) + 1}
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                          {brief.angle}
                        </p>
                        <p className="mt-1 text-[11px] text-ink-muted">
                          {[
                            brief.format,
                            brief.pillarSlug ? `pillar: ${brief.pillarSlug}` : null,
                            brief.hookFamily ? `hook: ${brief.hookFamily}` : null,
                            brief.objectiveKpi ? `for ${brief.objectiveKpi}` : null,
                            brief.plannedFor ? dateTimeLabel(brief.plannedFor) : "unscheduled",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        <p className="mt-1 text-[11px] text-ink-muted">
                          Serves: <span className="text-ink-secondary">{brief.strategyBasis}</span>
                        </p>
                        {brief.skipReason ? (
                          <p className="mt-1 text-[11px] text-ink-muted">
                            Skipped because: {brief.skipReason}
                          </p>
                        ) : null}
                      </div>
                      {brief.status === BriefStatus.PLANNED ||
                      brief.status === BriefStatus.IN_PRODUCTION ? (
                        <ActionForm
                          action={skipBriefAction}
                          className="flex shrink-0 items-center gap-1.5"
                        >
                          <input type="hidden" name="briefId" value={brief.id} />
                          <input
                            name="reason"
                            placeholder="Why skip?"
                            aria-label="Reason for skipping"
                            className="w-36 rounded-md border border-hairline bg-surface-raised px-2 py-1 text-[11.5px] text-ink placeholder:text-ink-muted"
                          />
                          <SubmitButton variant="ghost" size="sm" pendingLabel="…">
                            <SkipForward /> Skip
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}

        {history.length > 0 ? (
          <Card>
            <CardHeader
              title="Plan history"
              subtitle="Superseded plans keep their briefs. What was asked for is a record, whatever was made."
            />
            <ul className="divide-y divide-hairline">
              {history.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-[12.5px] text-ink">
                      v{entry.version} · {entry._count.briefs} briefs · strategy v
                      {entry.strategy.version}
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      {dateLabel(entry.startsOn)} to {dateLabel(entry.endsOn)} · written{" "}
                      {dateTimeLabel(entry.createdAt)} by {entry.generatedBy}
                    </p>
                  </div>
                  <Badge tone={planTone(entry.status)}>{entry.status}</Badge>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </PageBody>
    </>
  );
}

function MixColumn({
  label,
  planned,
  delivered,
}: {
  label: string;
  planned: Record<string, number>;
  delivered: Record<string, number>;
}) {
  const keys = [...new Set([...Object.keys(planned), ...Object.keys(delivered)])].sort();
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <ul className="mt-1 space-y-1">
        {keys.length === 0 ? (
          <li className="text-[11.5px] text-ink-muted">—</li>
        ) : (
          keys.map((key) => (
            <li key={key} className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[11.5px] text-ink-secondary">{key}</span>
              <span className="tabular shrink-0 text-[11.5px] text-ink-muted">
                {delivered[key] ?? 0} / {planned[key] ?? 0}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function briefTone(status: BriefStatus): BadgeTone {
  if (status === BriefStatus.FULFILLED) return "good";
  if (status === BriefStatus.READY) return "info";
  if (status === BriefStatus.SKIPPED) return "neutral";
  if (status === BriefStatus.IN_PRODUCTION) return "accent";
  return "neutral";
}

function planTone(status: ContentPlanStatus): BadgeTone {
  if (status === ContentPlanStatus.ACTIVE) return "good";
  if (status === ContentPlanStatus.DRAFT) return "warning";
  return "neutral";
}

function gaps(rationale: unknown): string[] {
  const value = (rationale as { gaps?: unknown } | null)?.gaps;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function dateLabel(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
