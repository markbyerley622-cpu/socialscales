import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, RefreshCw } from "lucide-react";
import { prisma } from "@/server/db";
import {
  dailySeries,
  loadPostFacts,
  median,
  totalsFromFacts,
  type PostFact,
} from "@/server/analytics/aggregate";
import { allReports, MIN_DATASET } from "@/server/learning/engine";
import { syncAnalyticsAction } from "@/app/actions/operations";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardHeader,
  EmptyState,
  ProjectDot,
} from "@/components/ui/primitives";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import { StatTile } from "@/components/charts/stat-tile";
import { ViewsTrend } from "@/components/charts/views-trend";
import { LiftBars, LiftTable } from "@/components/charts/lift-bars";
import { MetricSourceBadge, PlatformBadge } from "@/components/ui/status";
import {
  compactNumber,
  duration,
  humanize,
  multiple,
  percent,
  relativeTime,
} from "@/lib/utils";
import type { MetricSource, Platform } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Analytics" };
export const dynamic = "force-dynamic";

export default async function AnalyticsPage(props: PageProps<"/analytics">) {
  const params = await props.searchParams;
  const projectSlug = typeof params.project === "string" ? params.project : undefined;

  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, slug: true, name: true, accentColor: true },
  });

  const active = projects.find((project) => project.slug === projectSlug) ?? null;
  const facts = await loadPostFacts(active ? { projectId: active.id } : {});
  const totals = totalsFromFacts(facts);
  const reports = allReports(facts);
  const baseline = median(facts.map((fact) => fact.views));

  const topPosts = [...facts].sort((a, b) => b.views - a.views).slice(0, 10);
  const sources = new Set(facts.map((fact) => fact.source));

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Every published destination, read from its most mature snapshot so posts of different ages are never compared on unequal terms."
        actions={
          <ActionForm action={syncAnalyticsAction}>
            {active ? (
              <input type="hidden" name="projectId" value={active.id} />
            ) : null}
            <SubmitButton variant="secondary" pendingLabel="Syncing…">
              <RefreshCw />
              Sync analytics
            </SubmitButton>
          </ActionForm>
        }
      />

      <PageBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Link
            href="/analytics"
            aria-current={active ? undefined : "page"}
            className={`rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
              active
                ? "border-hairline bg-surface text-ink-secondary hover:text-ink"
                : "border-hairline-strong bg-surface-raised text-ink"
            }`}
          >
            All projects
          </Link>
          {projects.map((project) => {
            const isActive = active?.id === project.id;
            return (
              <Link
                key={project.id}
                href={`/analytics?project=${project.slug}`}
                aria-current={isActive ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                  isActive
                    ? "border-hairline-strong bg-surface-raised text-ink"
                    : "border-hairline bg-surface text-ink-secondary hover:text-ink"
                }`}
              >
                <ProjectDot color={project.accentColor} />
                {project.name}
              </Link>
            );
          })}
          {sources.size > 0 ? (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="text-[10.5px] text-ink-muted">Metric source:</span>
              {[...sources].map((source) => (
                <MetricSourceBadge key={source} source={source as MetricSource} />
              ))}
            </span>
          ) : null}
        </div>

        {facts.length === 0 ? (
          <Card>
            <EmptyState
              icon={<BarChart3 />}
              title="No analytics yet"
              body="Analytics appear once a post has published and the sync has captured at least one snapshot. Publish something, then use Sync analytics."
            />
          </Card>
        ) : (
          <>
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <StatTile label="Views" value={compactNumber(totals.views)} />
              <StatTile
                label="Median views"
                value={compactNumber(totals.medianViews)}
                hint="the baseline everything is compared to"
              />
              <StatTile
                label="Engagement"
                value={percent(totals.engagementRate)}
              />
              <StatTile
                label="Profile visits"
                value={compactNumber(totals.profileVisits)}
              />
              <StatTile label="Link clicks" value={compactNumber(totals.linkClicks)} />
              <StatTile
                label="Conversions"
                value={compactNumber(totals.conversions)}
                tone="accent"
              />
            </div>

            <Card>
              <CardHeader
                title="Daily views, last 30 days"
                subtitle={
                  active ? `${active.name} only.` : "All projects combined."
                }
              />
              <div className="px-3 py-3">
                <ViewsTrend data={dailySeries(facts, 30)} />
              </div>
            </Card>

            {facts.length < MIN_DATASET ? (
              <Card>
                <div className="px-4 py-3">
                  <p className="text-[11.5px] leading-relaxed text-[#f6c455]">
                    {facts.length} published destinations. Below {MIN_DATASET}, no
                    pattern below is treated as reliable — every group is capped at low
                    confidence regardless of how large its lift looks.
                  </p>
                </div>
              </Card>
            ) : null}

            {/* --- Learning dimensions ---------------------------------- */}
            <div className="grid gap-4 2xl:grid-cols-2">
              {reports.map((report) => (
                <Card key={report.dimension}>
                  <CardHeader
                    title={report.label}
                    subtitle={`${report.groups.length} group${report.groups.length === 1 ? "" : "s"} across ${report.datasetSize} published destinations.`}
                  />
                  <LiftBars
                    groups={report.groups}
                    baselineMedianViews={report.baselineMedianViews}
                  />
                  <details className="border-t border-hairline">
                    <summary className="cursor-pointer list-none px-4 py-2 text-[10.5px] text-ink-muted transition-colors hover:text-ink-secondary">
                      Table view
                    </summary>
                    <LiftTable groups={report.groups} />
                  </details>
                </Card>
              ))}
            </div>

            {/* --- Post-level dataset ----------------------------------- */}
            <Card>
              <CardHeader
                title="Top posts"
                subtitle="The per-post dataset the recommendation engine queries."
              />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[58rem] text-left text-[11.5px]">
                  <thead>
                    <tr className="border-b border-hairline text-[10.5px] uppercase tracking-wider text-ink-muted">
                      <th scope="col" className="px-4 py-2 font-semibold">Hook</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Platform</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Format</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Length</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Posted</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Views</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">vs median</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Completion</th>
                      <th scope="col" className="px-4 py-2 text-right font-semibold">Conv.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topPosts.map((fact) => (
                      <tr
                        key={fact.postPlatformId}
                        className="border-b border-hairline/60 last:border-0"
                      >
                        <td className="max-w-[22rem] px-4 py-2">
                          <Link
                            href={`/content/${fact.assetId}`}
                            className="line-clamp-1 text-ink hover:underline"
                          >
                            {fact.hook}
                          </Link>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-muted">
                            <ProjectDot color={fact.projectAccent} />
                            {fact.projectName} · {fact.windowLabel}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <PlatformBadge platform={fact.platform as Platform} />
                        </td>
                        <td className="px-3 py-2 text-ink-secondary">
                          {humanize(fact.format)}
                        </td>
                        <td className="px-3 py-2 text-right tabular text-ink-secondary">
                          {duration(fact.durationSeconds)}
                        </td>
                        <td className="px-3 py-2 text-right tabular text-ink-muted">
                          {relativeTime(fact.publishedAt)}
                        </td>
                        <td className="px-3 py-2 text-right tabular text-ink">
                          {fact.views.toLocaleString()}
                        </td>
                        <td className="px-3 py-2 text-right tabular text-ink-secondary">
                          {baseline > 0 ? multiple(fact.views / baseline) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular text-ink-secondary">
                          {percent(fact.completionRate, 0)}
                        </td>
                        <td className="px-4 py-2 text-right tabular text-ink-secondary">
                          {fact.conversions}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card>
              <CardHeader title="Per platform" />
              <div className="grid gap-3 px-4 py-3.5 sm:grid-cols-3">
                {groupByPlatform(facts).map((group) => (
                  <div key={group.platform}>
                    <div className="flex items-center gap-2">
                      <PlatformBadge platform={group.platform} />
                      <span className="text-[10.5px] tabular text-ink-muted">
                        n={group.count}
                      </span>
                    </div>
                    <dl className="mt-2 space-y-1">
                      <Row label="Views" value={compactNumber(group.views)} />
                      <Row label="Median" value={compactNumber(group.medianViews)} />
                      <Row label="Engagement" value={percent(group.engagementRate)} />
                      <Row label="Completion" value={percent(group.completionRate, 0)} />
                    </dl>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </PageBody>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] text-ink-muted">{label}</dt>
      <dd className="text-[11.5px] tabular text-ink-secondary">{value}</dd>
    </div>
  );
}

function groupByPlatform(facts: PostFact[]) {
  const grouped = new Map<Platform, PostFact[]>();
  for (const fact of facts) {
    const bucket = grouped.get(fact.platform);
    if (bucket) bucket.push(fact);
    else grouped.set(fact.platform, [fact]);
  }
  return [...grouped.entries()].map(([platform, group]) => {
    const views = group.reduce((sum, fact) => sum + fact.views, 0);
    const interactions = group.reduce(
      (sum, fact) => sum + fact.likes + fact.comments + fact.shares + fact.saves,
      0,
    );
    return {
      platform,
      count: group.length,
      views,
      medianViews: median(group.map((fact) => fact.views)),
      engagementRate: views > 0 ? interactions / views : 0,
      completionRate:
        group.reduce((sum, fact) => sum + fact.completionRate, 0) / group.length,
    };
  });
}
