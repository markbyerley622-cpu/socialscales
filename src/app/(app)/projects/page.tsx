import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, Radio, Sparkles } from "lucide-react";
import { prisma } from "@/server/db";
import {
  loadPostFacts,
  projectSummaries,
  type PostFact,
} from "@/server/analytics/aggregate";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import { Card, EmptyState, SectionLabel } from "@/components/ui/primitives";
import { Sparkline } from "@/components/charts/views-trend";
import { PolicyBadge } from "@/components/ui/status";
import { buttonClass } from "@/components/ui/button-styles";
import { compactNumber, percent } from "@/lib/utils";

export const metadata: Metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

/**
 * The first screen the spec asks for: one card per product idea under test, each
 * carrying its own scheduled/published counts and performance, isolated from the
 * others.
 */
export default async function ProjectsPage() {
  const [summaries, facts, accountsByProject] = await Promise.all([
    projectSummaries(),
    loadPostFacts(),
    prisma.socialAccount.findMany({
      select: { projectId: true, platform: true, status: true, handle: true },
    }),
  ]);

  if (summaries.length === 0) {
    return (
      <>
        <PageHeader title="Projects" />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Sparkles />}
              title="No projects yet"
              body="Run `npm run db:seed` to create the three demo projects, or add one from Settings."
            />
          </Card>
        </PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Projects"
        description="Each project is a separate product idea with its own brand voice, accounts, schedule, content library and performance history. Nothing crosses between them."
      />

      <PageBody>
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {summaries.map((project) => {
            const projectFacts = facts.filter((fact) => fact.projectId === project.id);
            const accounts = accountsByProject.filter(
              (account) => account.projectId === project.id,
            );

            return (
              <Card
                key={project.id}
                className="animate-fade-up overflow-hidden transition-colors hover:border-hairline-strong"
              >
                {/* The project's own colour is its identity, used consistently. */}
                <div
                  aria-hidden
                  className="h-[3px] w-full"
                  style={{ background: project.accentColor }}
                />

                <div className="px-4 pb-4 pt-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-[14.5px] font-semibold tracking-tight text-ink">
                        {project.name}
                      </h2>
                      {project.description ? (
                        <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-ink-muted">
                          {project.description}
                        </p>
                      ) : null}
                    </div>
                    <Sparkline
                      values={sparklineValues(projectFacts)}
                      color={project.accentColor}
                      className="h-7 w-[6.5rem] shrink-0 opacity-90"
                    />
                  </div>

                  <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-3">
                    <Metric
                      label="Views"
                      value={compactNumber(project.totals.views)}
                      note={`${project.publishedCount} destinations`}
                    />
                    <Metric
                      label="Engagement"
                      value={percent(project.totals.engagementRate)}
                      note="of views"
                    />
                    <Metric
                      label="Scheduled"
                      value={String(project.scheduledCount)}
                      note="upcoming"
                    />
                    <Metric
                      label="Median views"
                      value={compactNumber(project.totals.medianViews)}
                      note="its own baseline"
                    />
                  </div>

                  <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
                    <PolicyBadge policy={project.publishPolicy as never} />
                    <span className="inline-flex items-center gap-1 rounded-full border border-hairline-strong bg-surface-raised px-2 py-[3px] text-[10.5px] text-ink-secondary">
                      <Radio className="size-3" />
                      {project.connectedAccountCount}/{accounts.length} connected
                    </span>
                  </div>

                  <div className="mt-3.5 flex items-center gap-2 border-t border-hairline pt-3">
                    <Link
                      href={`/projects/${project.slug}`}
                      className={buttonClass("secondary", "sm")}
                    >
                      Open project
                      <ArrowUpRight />
                    </Link>
                    <Link
                      href={`/content?project=${project.slug}`}
                      className={buttonClass("ghost", "sm")}
                    >
                      Library
                    </Link>
                    <Link
                      href={`/analytics?project=${project.slug}`}
                      className={buttonClass("ghost", "sm")}
                    >
                      Analytics
                    </Link>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </PageBody>
    </>
  );
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <p className="mt-1 text-[17px] font-semibold leading-none tracking-tight text-ink">
        {value}
      </p>
      <p className="mt-1 text-[10.5px] text-ink-muted">{note}</p>
    </div>
  );
}

/** Chronological views for the card sparkline, oldest first. */
function sparklineValues(facts: PostFact[]): number[] {
  return [...facts]
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime())
    .slice(-14)
    .map((fact) => fact.views);
}
