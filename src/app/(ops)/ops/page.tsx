import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Clock,
  Eye,
  Heart,
  Lightbulb,
  MousePointerClick,
  Target,
  ThumbsUp,
  UploadCloud,
  UserRoundSearch,
  XCircle,
} from "lucide-react";
import { prisma } from "@/server/db";
import {
  dailySeries,
  loadPostFacts,
  projectSummaries,
  recentActivity,
  todayCounts,
  totalsFromFacts,
} from "@/server/analytics/aggregate";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import { Card, CardHeader, EmptyState, ProjectDot } from "@/components/ui/ops-primitives";
import { StatTile, MomentumRow } from "@/components/charts/stat-tile";
import { ViewsTrend } from "@/components/charts/views-trend";
import { ConfidenceBadge, PlatformIcon } from "@/components/ui/status";
import { buttonClass } from "@/components/ui/button-styles";
import {
  compactNumber,
  dateTimeLabel,
  percent,
  relativeTime,
} from "@/lib/utils";
import { PostStatus, RecommendationStatus } from "@/generated/prisma/enums";

export const metadata = { title: "Overview" };

// Always read live: this is an operations console, not a marketing page.
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [counts, facts, projects, recommendations, activity, upcoming] =
    await Promise.all([
      todayCounts(),
      loadPostFacts(),
      projectSummaries(),
      prisma.recommendation.findMany({
        where: { status: RecommendationStatus.OPEN },
        orderBy: [{ confidence: "asc" }, { createdAt: "desc" }],
        take: 4,
        include: { project: { select: { name: true, accentColor: true, slug: true } } },
      }),
      recentActivity(12),
      prisma.post.findMany({
        where: {
          status: PostStatus.SCHEDULED,
          scheduledFor: { gte: new Date() },
        },
        orderBy: { scheduledFor: "asc" },
        take: 6,
        include: {
          project: { select: { name: true, accentColor: true } },
          variant: { select: { hook: true } },
          targets: { select: { platform: true } },
        },
      }),
    ]);

  const totals = totalsFromFacts(facts);
  const series = dailySeries(facts, 30);

  // Confidence is stored ascending as HIGH < LOW alphabetically, so sort here.
  const ranked = [...recommendations].sort(
    (a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence),
  );

  return (
    <>
      <PageHeader
        title="Command centre"
        description="What is happening today, what is winning, and what to do about it. Every number below is computed from this install's own published history."
        actions={
          <Link href="/ops/content" className={buttonClass("primary", "md")}>
            <UploadCloud />
            Upload content
          </Link>
        }
      />

      <PageBody className="space-y-5">
        {/* --- What's happening ------------------------------------------- */}
        <section aria-labelledby="today-heading">
          <h2
            id="today-heading"
            className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted"
          >
            Today
          </h2>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <StatTile
              label="Scheduled"
              value={String(counts.scheduled)}
              icon={<CalendarClock />}
              hint="due today"
            />
            <StatTile
              label="Needs approval"
              value={String(counts.needsApproval)}
              icon={<Clock />}
              tone={counts.needsApproval > 0 ? "warning" : "neutral"}
              hint={counts.needsApproval > 0 ? "waiting on you" : "all clear"}
            />
            <StatTile
              label="Approved"
              value={String(counts.ready)}
              icon={<ThumbsUp />}
              hint="ready to schedule"
            />
            <StatTile
              label="Uploading"
              value={String(counts.uploading)}
              icon={<UploadCloud />}
              hint="in flight"
            />
            <StatTile
              label="Published"
              value={String(counts.published)}
              icon={<CheckCircle2 />}
              hint="destinations today"
            />
            <StatTile
              label="Failed"
              value={String(counts.failed)}
              icon={<XCircle />}
              tone={counts.failed > 0 ? "critical" : "neutral"}
              hint={counts.failed > 0 ? "needs a retry" : "none"}
            />
          </div>
        </section>

        {/* --- Performance ------------------------------------------------ */}
        <section aria-labelledby="performance-heading">
          <h2
            id="performance-heading"
            className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted"
          >
            Performance · all projects, latest snapshot per post
          </h2>
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <StatTile
              label="Views"
              value={compactNumber(totals.views)}
              icon={<Eye />}
              hint={`${totals.publishedCount} published destinations`}
            />
            <StatTile
              label="Engagement rate"
              value={percent(totals.engagementRate)}
              icon={<Heart />}
              hint="likes + comments + shares + saves"
            />
            <StatTile
              label="Profile visits"
              value={compactNumber(totals.profileVisits)}
              icon={<UserRoundSearch />}
            />
            <StatTile
              label="Link clicks"
              value={compactNumber(totals.linkClicks)}
              icon={<MousePointerClick />}
            />
            <StatTile
              label="Conversions"
              value={compactNumber(totals.conversions)}
              icon={<Target />}
              tone="accent"
            />
          </div>
        </section>

        {/* --- Trend + winning ------------------------------------------- */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader
              title="Daily views, last 30 days"
              subtitle="All projects combined. Hover for that day's posts and engagement."
              action={
                <Link href="/ops/analytics" className={buttonClass("ghost", "sm")}>
                  Analytics
                  <ArrowUpRight />
                </Link>
              }
            />
            <div className="px-3 py-3">
              <ViewsTrend data={series} />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="What's winning"
              subtitle="Each project's five most recent posts against its own all-time median."
            />
            <div className="divide-y divide-hairline px-4 py-1.5">
              {projects.map((project) => (
                <MomentumRow
                  key={project.id}
                  name={project.name}
                  color={project.accentColor}
                  momentum={project.momentum}
                  publishedCount={project.comparableCount}
                />
              ))}
            </div>
            <p className="border-t border-hairline px-4 py-2.5 text-[10.5px] leading-relaxed text-ink-muted">
              A project needs six published posts before a momentum figure is
              shown. Below that the number would be noise.
            </p>
          </Card>
        </div>

        {/* --- What should we do ----------------------------------------- */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader
              title="What should we do next"
              subtitle="Derived from published performance. Highest confidence first."
              action={
                <Link href="/ops/recommendations" className={buttonClass("ghost", "sm")}>
                  All
                  <ArrowUpRight />
                </Link>
              }
            />
            {ranked.length === 0 ? (
              <EmptyState
                icon={<Lightbulb />}
                title="No recommendations yet"
                body="The engine needs published posts with analytics before it will suggest anything. Publish, let the analytics sync run, and suggestions appear here."
              />
            ) : (
              <ul className="divide-y divide-hairline">
                {ranked.map((recommendation) => (
                  <li key={recommendation.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <ProjectDot color={recommendation.project.accentColor} />
                      <span className="text-[11px] text-ink-muted">
                        {recommendation.project.name}
                      </span>
                      <ConfidenceBadge confidence={recommendation.confidence} />
                      <span className="text-[10.5px] tabular text-ink-muted">
                        n={recommendation.sampleSize}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[13px] font-medium leading-snug text-ink">
                      {recommendation.title}
                    </p>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                      {recommendation.rationale}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader
                title="Next out the door"
                subtitle="Approved and scheduled."
                action={
                  <Link href="/ops/calendar" className={buttonClass("ghost", "sm")}>
                    Calendar
                    <ArrowUpRight />
                  </Link>
                }
              />
              {upcoming.length === 0 ? (
                <EmptyState
                  icon={<CalendarClock />}
                  title="Nothing scheduled"
                  body="Approve a post and give it a time to see it queue up here."
                />
              ) : (
                <ul className="divide-y divide-hairline">
                  {upcoming.map((post) => (
                    <li key={post.id} className="flex items-start gap-3 px-4 py-2.5">
                      <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
                        <ProjectDot color={post.project.accentColor} />
                        {post.targets.map((target, index) => (
                          <PlatformIcon key={index} platform={target.platform} />
                        ))}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12.5px] text-ink">
                          {post.variant.hook}
                        </p>
                        <p className="mt-0.5 text-[10.5px] text-ink-muted">
                          {post.project.name} ·{" "}
                          {post.scheduledFor ? dateTimeLabel(post.scheduledFor) : "unscheduled"}
                        </p>
                      </div>
                      {post.scheduledFor ? (
                        <span className="shrink-0 text-[10.5px] tabular text-ink-muted">
                          {relativeTime(post.scheduledFor)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Activity"
                subtitle="Every state change, newest first."
                action={
                  <Link href="/ops/activity" className={buttonClass("ghost", "sm")}>
                    Full log
                    <ArrowUpRight />
                  </Link>
                }
              />
              <ul className="divide-y divide-hairline">
                {activity.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2.5 px-4 py-2">
                    <span className="mt-1.5 shrink-0">
                      {entry.action.includes("failed") ? (
                        <AlertTriangle className="size-3 text-critical" />
                      ) : (
                        <span
                          aria-hidden
                          className="block size-1.5 rounded-full"
                          style={{
                            background: entry.project?.accentColor ?? "var(--color-ink-muted)",
                          }}
                        />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11.5px] leading-snug text-ink-secondary">
                        {entry.message}
                      </p>
                      <p className="mt-0.5 text-[10px] text-ink-muted">
                        {entry.project?.name ? `${entry.project.name} · ` : ""}
                        {entry.user?.name ? `${entry.user.name} · ` : ""}
                        {relativeTime(entry.createdAt)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      </PageBody>
    </>
  );
}

function confidenceRank(confidence: string): number {
  return confidence === "HIGH" ? 3 : confidence === "MEDIUM" ? 2 : 1;
}
