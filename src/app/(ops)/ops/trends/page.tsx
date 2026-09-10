import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDownRight, ArrowRight, ArrowUpRight, RefreshCw, TrendingUp } from "lucide-react";
import { prisma } from "@/server/db";
import { latestTrends } from "@/server/learning/trends";
import { refreshLearningAction } from "@/app/actions/operations";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardHeader,
  EmptyState,
  Meter,
  ProjectDot,
} from "@/components/ui/ops-primitives";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-styles";
import { PlatformBadge } from "@/components/ui/status";
import { percent, relativeTime } from "@/lib/utils";
import { TrendMomentum } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Trends" };
export const dynamic = "force-dynamic";

/**
 * Trends, with an honest header about where they come from.
 *
 * No external trend API is configured — and there is no public endpoint for these
 * platforms that can be used without an approved developer agreement. So rather
 * than scrape or fabricate, this surfaces movement in our own topics, measured
 * from our own results.
 */
export default async function TrendsPage() {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true, accentColor: true },
  });

  const byProject = await Promise.all(
    projects.map(async (project) => ({
      project,
      trends: await latestTrends(project.id, 10),
    })),
  );

  const anyTrends = byProject.some((entry) => entry.trends.length > 0);

  return (
    <>
      <PageHeader
        title="Trends"
        description="Movement in the topics this account already publishes, measured against its own earlier results."
        actions={
          <ActionForm action={refreshLearningAction}>
            <SubmitButton variant="secondary" pendingLabel="Recomputing…">
              <RefreshCw />
              Recompute
            </SubmitButton>
          </ActionForm>
        }
      />

      <PageBody className="space-y-4">
        <Card>
          <CardHeader title="Where this data comes from" />
          <div className="space-y-2 px-4 py-3.5 text-[11.5px] leading-relaxed text-ink-secondary">
            <p>
              No external trend source is connected. TikTok, Instagram and YouTube do
              not expose &ldquo;what is trending&rdquo; to an unapproved application,
              and this system does not scrape it. Every row below is labelled{" "}
              <code className="text-ink">local-history</code>: it is a hashtag from our
              own library whose recent posts are outperforming — or trailing — its own
              earlier posts.
            </p>
            <p className="text-ink-muted">
              To add a real source, implement a function returning the same shape and
              register it in <code>src/server/learning/trends.ts</code>. Nothing else
              needs to change; the page reports whatever <code>source</code> the row
              carries.
            </p>
          </div>
        </Card>

        {!anyTrends ? (
          <Card>
            <EmptyState
              icon={<TrendingUp />}
              title="No observations yet"
              body="At least four published posts with hashtags are needed before movement can be measured. Publish more, then recompute."
            />
          </Card>
        ) : (
          byProject
            .filter((entry) => entry.trends.length > 0)
            .map(({ project, trends }) => (
              <Card key={project.id}>
                <CardHeader
                  title={
                    <span className="inline-flex items-center gap-2">
                      <ProjectDot color={project.accentColor} />
                      {project.name}
                    </span>
                  }
                  subtitle={`${trends.length} topic${trends.length === 1 ? "" : "s"} tracked.`}
                />
                <ul className="divide-y divide-hairline">
                  {trends.map((trend) => (
                    <li key={trend.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[13px] font-medium text-accent-ink">
                              {trend.topic}
                            </span>
                            <MomentumChip momentum={trend.momentum} />
                            <PlatformBadge platform={trend.platform} />
                          </div>
                          {trend.recommendedAngle ? (
                            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
                              {trend.recommendedAngle}
                            </p>
                          ) : (
                            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-muted">
                              Holding steady. No action suggested.
                            </p>
                          )}
                          <p className="mt-1 text-[10px] text-ink-muted">
                            source: {trend.source} · observed {relativeTime(trend.observedAt)}
                          </p>
                        </div>

                        <div className="w-40 shrink-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-[10px] uppercase tracking-wider text-ink-muted">
                              Relevance
                            </span>
                            <span className="text-[11px] tabular text-ink-secondary">
                              {percent(trend.relevanceScore, 0)}
                            </span>
                          </div>
                          <div className="mt-1.5">
                            <Meter value={trend.relevanceScore} max={1} />
                          </div>
                          <Link
                            href={`/ops/content?project=${project.slug}`}
                            className={buttonClass("ghost", "sm", "mt-2 w-full")}
                          >
                            Create a draft
                          </Link>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ))
        )}
      </PageBody>
    </>
  );
}

function MomentumChip({ momentum }: { momentum: TrendMomentum }) {
  if (momentum === TrendMomentum.RISING) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-[#4cc94c]">
        <ArrowUpRight className="size-3" />
        Rising
      </span>
    );
  }
  if (momentum === TrendMomentum.FALLING) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-[#ec7d7d]">
        <ArrowDownRight className="size-3" />
        Cooling
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-ink-muted">
      <ArrowRight className="size-3" />
      Steady
    </span>
  );
}
