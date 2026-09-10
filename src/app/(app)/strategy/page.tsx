import type { Metadata } from "next";
import { Compass, FlaskConical, ShieldAlert } from "lucide-react";
import { prisma } from "@/server/db";
import { activeStrategy, strategyHistory, strategyRationale } from "@/server/strategy";
import {
  activateStrategyAction,
  generateStrategyAction,
} from "@/app/actions/operations";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import type { BadgeTone } from "@/components/ui/primitives";
import {
  Badge,
  Card,
  CardHeader,
  Divider,
  EmptyState,
  KeyValue,
  ProjectDot,
  SectionLabel,
} from "@/components/ui/primitives";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import { ConfidenceBadge } from "@/components/ui/status";
import { dateTimeLabel } from "@/lib/utils";
import { EvidenceType, StrategyStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Strategy" };
export const dynamic = "force-dynamic";

/**
 * The strategy screen.
 *
 * Its job is to make the *basis* for a strategy as visible as the strategy
 * itself. Every decision panel shows which evidence classes stand behind it and
 * how strongly — so an operator can tell "this is what your account did" from
 * "this is a general assumption we shipped", which is the whole point of keeping
 * those classes separate.
 */
export default async function StrategyPage({
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
        <PageHeader title="Strategy" description="One versioned plan per brand." />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Compass />}
              title="No projects yet"
              body="A strategy is written for one brand. Create a project first."
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const selected =
    projects.find((project) => project.slug === params.project) ?? projects[0]!;

  const [current, history] = await Promise.all([
    activeStrategy(selected.id),
    strategyHistory(selected.id),
  ]);
  const rationale = current ? await strategyRationale(current.id) : null;

  return (
    <>
      <PageHeader
        title="Strategy"
        description="What this brand is trying to do, why, and what that rests on. Versions are immutable — a new one supersedes the old rather than editing it."
        actions={
          <ActionForm action={generateStrategyAction} className="flex items-center gap-2">
            <input type="hidden" name="projectId" value={selected.id} />
            <input type="hidden" name="activate" value="1" />
            <SubmitButton pendingLabel="Drafting…">
              {current ? "Draft a new version" : "Draft the first strategy"}
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
                href={`/strategy?project=${project.slug}`}
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

        {!current ? (
          <Card>
            <EmptyState
              icon={<Compass />}
              title="No active strategy for this brand"
              body="Drafting one reads whatever evidence exists — this account's own results if there are any, and general priors if there are not — and says plainly which it used."
            />
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader
                title={`Version ${current.version}`}
                subtitle={`Written ${dateTimeLabel(current.createdAt)} by ${current.generatedBy}${current.model ? ` (${current.model})` : " — rules, no language model"}, prompt ${current.promptVersion ?? "unversioned"}.`}
                action={<ConfidenceBadge confidence={current.confidence} />}
              />
              <div className="space-y-4 px-4 py-4">
                <p className="text-[13px] leading-relaxed text-ink">{current.summary}</p>

                <Divider />

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <KeyValue label="Target audience">
                    {current.targetAudience?.name ?? "Not narrowed"}
                  </KeyValue>
                  <KeyValue label="Hook families">
                    {current.hookFamilies.join(", ") || "—"}
                  </KeyValue>
                  <KeyValue label="Formats">
                    {current.recommendedFormats.join(", ") || "—"}
                  </KeyValue>
                  <KeyValue label="Pillars">
                    {current.contentPillars.join(", ") || "—"}
                  </KeyValue>
                  <KeyValue label="Call to action">{current.ctaStrategy ?? "—"}</KeyValue>
                  <KeyValue label="Cadence">{cadenceLabel(current.cadence)}</KeyValue>
                </div>
              </div>
            </Card>

            {/* --- Why this? ------------------------------------------------ */}
            <Card>
              <CardHeader
                title="Why this?"
                subtitle="Each decision with the evidence behind it. Classes are shown separately because three priors and one experiment is not the same situation as four priors."
              />
              {rationale && rationale.decisions.length > 0 ? (
                <ul className="divide-y divide-hairline">
                  {rationale.decisions.map((entry) => (
                    <li key={entry.decision} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[12.5px] font-medium text-ink">
                          {decisionLabel(entry.decision)}
                        </p>
                        {entry.priorOnly ? (
                          <Badge tone="warning" icon={<ShieldAlert />}>
                            General priors only
                          </Badge>
                        ) : null}
                        {Object.entries(entry.classes).map(([type, count]) => (
                          <Badge key={type} tone={classTone(type)}>
                            {classLabel(type)} × {count}
                          </Badge>
                        ))}
                      </div>
                      <ul className="mt-2 space-y-1.5">
                        {entry.links.slice(0, 5).map((link) => (
                          <li
                            key={link.evidenceSourceId}
                            className="flex items-start justify-between gap-3"
                          >
                            <p className="text-[11.5px] leading-relaxed text-ink-secondary">
                              {link.evidence.claim}
                            </p>
                            <span
                              className="shrink-0 tabular text-[11px] text-ink-muted"
                              title="Computed weight: inferential strength × relevance × recency × sample adequacy × effect magnitude × confidence"
                            >
                              {link.strength.toFixed(2)}
                            </span>
                          </li>
                        ))}
                        {entry.links.length > 5 ? (
                          <li className="text-[11px] text-ink-muted">
                            and {entry.links.length - 5} more
                          </li>
                        ) : null}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState
                  title="No evidence linked"
                  body="This strategy was written without any evidence to cite, which makes all of it an assumption."
                />
              )}
            </Card>

            {/* --- Hypotheses and risks ------------------------------------- */}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader
                  title="Hypotheses"
                  subtitle="What this strategy is betting on, and how the account would find out."
                />
                <ul className="divide-y divide-hairline">
                  {hypotheses(current.hypotheses).map((entry, index) => (
                    <li key={index} className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <SectionLabel>{entry.dimension}</SectionLabel>
                        {entry.basedOn.length === 0 ? (
                          <Badge tone="warning" icon={<FlaskConical />}>
                            Untested guess
                          </Badge>
                        ) : (
                          <Badge tone="neutral">
                            {entry.basedOn.length} cited
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-ink">
                        {entry.claim}
                      </p>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                        How to test: {entry.howToTest}
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card>
                <CardHeader
                  title="Risks"
                  subtitle="What could make this wrong, stated before it is."
                />
                <ul className="divide-y divide-hairline">
                  {risks(current.risks).map((entry, index) => (
                    <li key={index} className="px-4 py-3">
                      <p className="text-[12.5px] leading-relaxed text-ink">{entry.risk}</p>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                        Mitigation: {entry.mitigation}
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </>
        )}

        {/* --- History ---------------------------------------------------- */}
        {history.length > 0 ? (
          <Card>
            <CardHeader
              title="Version history"
              subtitle="Nothing is edited or deleted. What the system believed at each point stays readable."
            />
            <ul className="divide-y divide-hairline">
              {history.map((version) => (
                <li
                  key={version.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-[12.5px] text-ink">
                      v{version.version} · {version.summary.slice(0, 110)}
                      {version.summary.length > 110 ? "…" : ""}
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      {dateTimeLabel(version.createdAt)} · {version._count.evidence} evidence
                      links · {version.generatedBy}
                      {version.model ? ` (${version.model})` : " (rules)"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={statusTone(version.status)}>{version.status}</Badge>
                    {version.status === StrategyStatus.DRAFT ? (
                      <ActionForm action={activateStrategyAction}>
                        <input type="hidden" name="strategyId" value={version.id} />
                        <SubmitButton variant="ghost" size="sm" pendingLabel="Activating…">
                          Activate
                        </SubmitButton>
                      </ActionForm>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </PageBody>
    </>
  );
}

function decisionLabel(decision: string): string {
  if (decision === "hookFamilies") return "Hook families";
  if (decision === "recommendedFormats") return "Recommended formats";
  if (decision.startsWith("hypotheses.")) {
    return `Hypothesis ${Number(decision.split(".")[1] ?? 0) + 1}`;
  }
  return decision;
}

function classLabel(type: string): string {
  if (type === EvidenceType.ACCOUNT_EVIDENCE) return "This account";
  if (type === EvidenceType.EXPERIMENT_EVIDENCE) return "Experiment";
  if (type === EvidenceType.EXTERNAL_EVIDENCE) return "External";
  return "General prior";
}

function classTone(type: string): BadgeTone {
  if (type === EvidenceType.EXPERIMENT_EVIDENCE) return "good";
  if (type === EvidenceType.ACCOUNT_EVIDENCE) return "info";
  return "neutral";
}

function statusTone(status: StrategyStatus): BadgeTone {
  if (status === StrategyStatus.ACTIVE) return "good";
  if (status === StrategyStatus.DRAFT) return "warning";
  return "neutral";
}

function cadenceLabel(value: unknown): string {
  const cadence = value as { postsPerWeek?: number; notes?: string } | null;
  if (!cadence?.postsPerWeek) return "—";
  return `${cadence.postsPerWeek} a week${cadence.notes ? ` — ${cadence.notes}` : ""}`;
}

function hypotheses(value: unknown) {
  return (value as Array<{
    claim: string;
    dimension: string;
    howToTest: string;
    basedOn: string[];
  }>) ?? [];
}

function risks(value: unknown) {
  return (value as Array<{ risk: string; mitigation: string }>) ?? [];
}
