import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, UploadCloud } from "lucide-react";
import { prisma } from "@/server/db";
import {
  dailySeries,
  loadPostFacts,
  recentActivity,
  todayCounts,
  totalsFromFacts,
  recentMomentum,
} from "@/server/analytics/aggregate";
import { allReports } from "@/server/learning/engine";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  KeyValue,
  ProjectDot,
  SectionLabel,
} from "@/components/ui/primitives";
import { StatTile } from "@/components/charts/stat-tile";
import { ViewsTrend } from "@/components/charts/views-trend";
import { LiftBars } from "@/components/charts/lift-bars";
import { buttonClass } from "@/components/ui/button-styles";
import {
  AccountStatusBadge,
  ConfidenceBadge,
  PlatformBadge,
  PolicyBadge,
  PostStatusBadge,
} from "@/components/ui/status";
import {
  compactNumber,
  dayName,
  minuteOfDayLabel,
  multiple,
  percent,
  relativeTime,
} from "@/lib/utils";
import { RecommendationStatus } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: PageProps<"/projects/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { name: true },
  });
  return { title: project?.name ?? "Project" };
}

/** Everything about one product idea, isolated from the others. */
export default async function ProjectPage(props: PageProps<"/projects/[slug]">) {
  const { slug } = await props.params;

  const project = await prisma.project.findUnique({
    where: { slug },
    include: {
      brand: true,
      pillars: { orderBy: { name: "asc" } },
      hashtags: { orderBy: { usageCount: "desc" }, take: 12 },
      accounts: { orderBy: { platform: "asc" } },
      schedules: { include: { slots: { orderBy: [{ dayOfWeek: "asc" }, { minuteOfDay: "asc" }] } } },
      _count: { select: { assets: true, posts: true } },
    },
  });

  if (!project) notFound();

  const [facts, counts, recommendations, activity, recentPosts] = await Promise.all([
    loadPostFacts({ projectId: project.id }),
    todayCounts(project.id),
    prisma.recommendation.findMany({
      where: { projectId: project.id, status: RecommendationStatus.OPEN },
      orderBy: { createdAt: "desc" },
      take: 4,
    }),
    recentActivity(14, project.id),
    prisma.post.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        variant: { select: { hook: true } },
        asset: { select: { id: true, title: true } },
        targets: { select: { platform: true } },
      },
    }),
  ]);

  const totals = totalsFromFacts(facts);
  const momentum = recentMomentum(facts);
  const reports = allReports(facts);
  const hookReport = reports.find((report) => report.dimension === "hook");
  const defaultSchedule = project.schedules.find((schedule) => schedule.isDefault);

  return (
    <>
      <PageHeader
        title={project.name}
        description={project.description ?? undefined}
        actions={
          <>
            <Link href="/projects" className={buttonClass("ghost", "md")}>
              <ArrowLeft />
              All projects
            </Link>
            <Link
              href={`/content?project=${project.slug}`}
              className={buttonClass("primary", "md")}
            >
              <UploadCloud />
              Upload
            </Link>
          </>
        }
      />

      <PageBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <ProjectDot color={project.accentColor} />
          <PolicyBadge policy={project.publishPolicy} />
          <Badge tone="neutral">{project.timezone}</Badge>
          <Badge tone="neutral">{project._count.assets} assets</Badge>
          <Badge tone="neutral">{project._count.posts} posts</Badge>
          {momentum !== null ? (
            <Badge tone={momentum >= 1 ? "good" : "warning"}>
              {multiple(momentum)} recent vs own median
            </Badge>
          ) : (
            <Badge tone="neutral">
              {facts.length} published · need 6 for momentum
            </Badge>
          )}
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <StatTile label="Views" value={compactNumber(totals.views)} />
          <StatTile label="Median views" value={compactNumber(totals.medianViews)} />
          <StatTile label="Engagement" value={percent(totals.engagementRate)} />
          <StatTile label="Conversions" value={compactNumber(totals.conversions)} tone="accent" />
          <StatTile
            label="Needs approval"
            value={String(counts.needsApproval)}
            tone={counts.needsApproval > 0 ? "warning" : "neutral"}
          />
          <StatTile
            label="Failed"
            value={String(counts.failed)}
            tone={counts.failed > 0 ? "critical" : "neutral"}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader
              title="Daily views, last 30 days"
              action={
                <Link
                  href={`/analytics?project=${project.slug}`}
                  className={buttonClass("ghost", "sm")}
                >
                  Analytics
                  <ArrowUpRight />
                </Link>
              }
            />
            <div className="px-3 py-3">
              <ViewsTrend data={dailySeries(facts, 30)} />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Brand context"
              subtitle="What the AI layer is allowed to use when drafting copy for this project."
            />
            <dl className="space-y-3 px-4 py-3.5">
              <KeyValue label="Audience">{project.brand?.audience ?? "—"}</KeyValue>
              <KeyValue label="Tone">{project.brand?.tone ?? "—"}</KeyValue>
              <KeyValue label="Value proposition">{project.brand?.valueProp ?? "—"}</KeyValue>
              <KeyValue label="Primary CTA">{project.brand?.primaryCta ?? "—"}</KeyValue>
              {project.brand?.website ? (
                <KeyValue label="Website">{project.brand.website}</KeyValue>
              ) : null}
              {project.brand?.bannedPhrases.length ? (
                <KeyValue label="Never say">
                  {project.brand.bannedPhrases.join(", ")}
                </KeyValue>
              ) : null}
            </dl>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader
              title="Hook patterns"
              subtitle="Which openers this project's own audience responds to."
            />
            {hookReport ? (
              <LiftBars
                groups={hookReport.groups}
                baselineMedianViews={hookReport.baselineMedianViews}
              />
            ) : null}
          </Card>

          <Card>
            <CardHeader
              title="Recommendations"
              action={
                <Link href="/recommendations" className={buttonClass("ghost", "sm")}>
                  All
                  <ArrowUpRight />
                </Link>
              }
            />
            {recommendations.length === 0 ? (
              <EmptyState
                title="Nothing yet"
                body="Publish more posts and sync analytics; suggestions follow from the data."
              />
            ) : (
              <ul className="divide-y divide-hairline">
                {recommendations.map((recommendation) => (
                  <li key={recommendation.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ConfidenceBadge confidence={recommendation.confidence} />
                      <span className="text-[10.5px] tabular text-ink-muted">
                        n={recommendation.sampleSize}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[12.5px] font-medium leading-snug text-ink">
                      {recommendation.title}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                      {recommendation.rationale}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <Card>
            <CardHeader title="Accounts" />
            <ul className="divide-y divide-hairline">
              {project.accounts.map((account) => (
                <li
                  key={account.id}
                  className="flex flex-wrap items-center gap-2 px-4 py-2.5"
                >
                  <PlatformBadge platform={account.platform} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                    {account.handle}
                  </span>
                  <AccountStatusBadge status={account.status} />
                </li>
              ))}
              {project.accounts.length === 0 ? (
                <li className="px-4 py-3 text-[11.5px] text-ink-muted">
                  No accounts yet.
                </li>
              ) : null}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Content pillars" />
            <ul className="divide-y divide-hairline">
              {project.pillars.map((pillar) => (
                <li key={pillar.id} className="px-4 py-2.5">
                  <p className="text-[12px] text-ink">{pillar.name}</p>
                  {pillar.description ? (
                    <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-muted">
                      {pillar.description}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="border-t border-hairline px-4 py-3">
              <SectionLabel>Hashtag vocabulary</SectionLabel>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-accent-ink">
                {project.hashtags.map((hashtag) => hashtag.tag).join(" ") || "none yet"}
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Cadence"
              subtitle={defaultSchedule?.name ?? "No default schedule."}
            />
            <ul className="divide-y divide-hairline">
              {(defaultSchedule?.slots ?? []).map((slot) => (
                <li
                  key={slot.id}
                  className="flex items-baseline justify-between gap-3 px-4 py-2"
                >
                  <span className="text-[12px] text-ink-secondary">
                    {dayName(slot.dayOfWeek)}
                  </span>
                  <span className="text-[11.5px] tabular text-ink-muted">
                    {minuteOfDayLabel(slot.minuteOfDay)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="Recent posts" />
            <ul className="divide-y divide-hairline">
              {recentPosts.map((post) => (
                <li key={post.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <PostStatusBadge status={post.status} />
                  <Link
                    href={`/content/${post.asset.id}`}
                    className="min-w-0 flex-1 truncate text-[12px] text-ink hover:underline"
                  >
                    {post.variant.hook}
                  </Link>
                  <span className="text-[10.5px] tabular text-ink-muted">
                    {relativeTime(post.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Activity"
              action={
                <Link
                  href={`/activity?project=${project.slug}`}
                  className={buttonClass("ghost", "sm")}
                >
                  Full log
                  <ArrowUpRight />
                </Link>
              }
            />
            <ul className="divide-y divide-hairline">
              {activity.map((entry) => (
                <li key={entry.id} className="px-4 py-2">
                  <p className="text-[11.5px] leading-snug text-ink-secondary">
                    {entry.message}
                  </p>
                  <p className="mt-0.5 text-[10px] text-ink-muted">
                    {relativeTime(entry.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </PageBody>
    </>
  );
}
