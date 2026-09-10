import type { Metadata } from "next";
import Link from "next/link";
import { Check, Lightbulb, RefreshCw, X } from "lucide-react";
import { prisma } from "@/server/db";
import { loadPostFacts } from "@/server/analytics/aggregate";
import { CONFIDENCE_RULES, MIN_DATASET, MIN_GROUP } from "@/server/learning/engine";
import {
  refreshLearningAction,
  setRecommendationStatusAction,
} from "@/app/actions/operations";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ProjectDot,
  SectionLabel,
} from "@/components/ui/ops-primitives";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-styles";
import { ConfidenceBadge } from "@/components/ui/status";
import { humanize, minuteOfDayLabel, multiple, relativeTime } from "@/lib/utils";
import {
  Confidence,
  RecommendationKind,
  RecommendationStatus,
} from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Recommendations" };
export const dynamic = "force-dynamic";

const KIND_LABELS: Record<RecommendationKind, string> = {
  DOUBLE_DOWN: "Do more of this",
  EXPERIMENT: "Go find out",
  TIMING: "Timing",
  FORMAT: "Format",
  CTA: "Call to action",
};

/**
 * "What should we post next?"
 *
 * Every card carries the evidence it was built from. There is no invented viral
 * score anywhere on this page: a recommendation states a measured lift against
 * this project's own median, the sample size behind it, and an explicit
 * confidence with the reasoning for that confidence.
 */
export default async function RecommendationsPage() {
  const [open, decided, facts] = await Promise.all([
    prisma.recommendation.findMany({
      where: { status: RecommendationStatus.OPEN },
      orderBy: { createdAt: "desc" },
      include: { project: { select: { name: true, accentColor: true, slug: true } } },
    }),
    prisma.recommendation.findMany({
      where: {
        status: { in: [RecommendationStatus.ACCEPTED, RecommendationStatus.DISMISSED] },
      },
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { project: { select: { name: true, accentColor: true } } },
    }),
    loadPostFacts(),
  ]);

  const ranked = [...open].sort(
    (a, b) => rank(b.confidence) - rank(a.confidence) || b.sampleSize - a.sampleSize,
  );

  const high = ranked.filter((row) => row.confidence === Confidence.HIGH);
  const medium = ranked.filter((row) => row.confidence === Confidence.MEDIUM);
  const low = ranked.filter((row) => row.confidence === Confidence.LOW);

  return (
    <>
      <PageHeader
        title="What should we post next"
        description="Derived only from what this install has actually published. No external benchmarks, no predicted virality."
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
          <CardHeader title="How these are decided" />
          <div className="grid gap-4 px-4 py-3.5 sm:grid-cols-3">
            <div>
              <SectionLabel>Baseline</SectionLabel>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                Every lift is measured against the project&rsquo;s own median views,
                across {facts.length} published destinations. Nothing is compared to an
                industry figure.
              </p>
            </div>
            <div>
              <SectionLabel>Confidence</SectionLabel>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                High needs {CONFIDENCE_RULES.high.minSample}+ posts in the group and a{" "}
                {Math.round(CONFIDENCE_RULES.high.minEffect * 100)}%+ effect. Medium
                needs {CONFIDENCE_RULES.medium.minSample}+ and{" "}
                {Math.round(CONFIDENCE_RULES.medium.minEffect * 100)}%. Below{" "}
                {MIN_DATASET} posts in a project, nothing gets above low.
              </p>
            </div>
            <div>
              <SectionLabel>What it will not do</SectionLabel>
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                It will not claim a post will go viral, invent a score, or recommend a
                group with fewer than {MIN_GROUP} posts behind it. Small-sample signals
                appear as experiments to run, not conclusions.
              </p>
            </div>
          </div>
        </Card>

        {ranked.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Lightbulb />}
              title="Nothing to recommend yet"
              body="The engine needs published posts with analytics attached. Publish, sync analytics, then recompute."
            />
          </Card>
        ) : (
          <>
            <Group
              title="High confidence"
              subtitle="Enough posts and a large enough effect to act on."
              rows={high}
            />
            <Group
              title="Worth acting on"
              subtitle="Real signal, smaller sample. Treat as a strong hypothesis."
              rows={medium}
            />
            <Group
              title="Experiments and weak signals"
              subtitle="Reported for completeness. These are questions, not answers."
              rows={low}
            />
          </>
        )}

        {decided.length > 0 ? (
          <Card>
            <CardHeader
              title="Decided"
              subtitle="Accepted and dismissed recommendations stay on the record with their evidence."
            />
            <ul className="divide-y divide-hairline">
              {decided.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                  <Badge
                    tone={row.status === RecommendationStatus.ACCEPTED ? "good" : "neutral"}
                  >
                    {humanize(row.status)}
                  </Badge>
                  <ProjectDot color={row.project.accentColor} />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink-secondary">
                    {row.title}
                  </span>
                  <span className="text-[10.5px] tabular text-ink-muted">
                    {relativeTime(row.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </PageBody>
    </>
  );
}

type Row = Awaited<
  ReturnType<typeof prisma.recommendation.findMany<{
    include: { project: { select: { name: true; accentColor: true; slug: true } } };
  }>>
>[number];

function Group({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: Row[];
}) {
  if (rows.length === 0) return null;

  return (
    <section>
      <div className="mb-2">
        <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
        <p className="mt-0.5 text-[11.5px] text-ink-muted">{subtitle}</p>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        {rows.map((row) => (
          <Card key={row.id} className="animate-fade-up">
            <div className="px-4 pb-3.5 pt-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <ProjectDot color={row.project.accentColor} />
                <span className="text-[11px] text-ink-muted">{row.project.name}</span>
                <Badge tone="neutral">{KIND_LABELS[row.kind]}</Badge>
                <ConfidenceBadge confidence={row.confidence} />
                <span className="text-[10.5px] tabular text-ink-muted">
                  n={row.sampleSize}
                </span>
              </div>

              <h3 className="mt-2 text-[14px] font-medium leading-snug text-ink">
                {row.title}
              </h3>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
                {row.rationale}
              </p>

              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-hairline pt-3">
                {row.expectedLift !== null ? (
                  <Detail label="Measured lift" value={multiple(row.expectedLift)} />
                ) : null}
                {row.suggestedFormat ? (
                  <Detail label="Format" value={humanize(row.suggestedFormat)} />
                ) : null}
                {row.suggestedMinSeconds !== null ? (
                  <Detail
                    label="Runtime"
                    value={
                      row.suggestedMaxSeconds !== null
                        ? `${row.suggestedMinSeconds}–${row.suggestedMaxSeconds}s`
                        : `${row.suggestedMinSeconds}s+`
                    }
                  />
                ) : null}
                {row.windowStartMinute !== null && row.windowEndMinute !== null ? (
                  <Detail
                    label="Posting window"
                    value={`${minuteOfDayLabel(row.windowStartMinute)} – ${minuteOfDayLabel(row.windowEndMinute)}`}
                  />
                ) : null}
              </dl>

              {row.suggestedHook ? (
                <div className="mt-3">
                  <SectionLabel>Best-performing hook in this group</SectionLabel>
                  <p className="mt-1 rounded-md border border-hairline bg-surface-raised px-2.5 py-2 text-[12px] leading-snug text-ink">
                    {row.suggestedHook}
                  </p>
                </div>
              ) : null}

              <details className="mt-3">
                <summary className="cursor-pointer list-none text-[10.5px] text-ink-muted transition-colors hover:text-ink-secondary">
                  Show the numbers this came from
                </summary>
                <pre className="mt-1.5 overflow-x-auto rounded-md border border-hairline bg-surface-raised px-2.5 py-2 text-[10px] leading-relaxed text-ink-secondary">
                  {JSON.stringify(row.evidence, null, 2)}
                </pre>
              </details>

              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-hairline pt-3">
                <ActionForm action={setRecommendationStatusAction}>
                  <input type="hidden" name="recommendationId" value={row.id} />
                  <input
                    type="hidden"
                    name="status"
                    value={RecommendationStatus.ACCEPTED}
                  />
                  <SubmitButton variant="secondary" size="sm" pendingLabel="Saving…">
                    <Check />
                    Accept
                  </SubmitButton>
                </ActionForm>
                <ActionForm action={setRecommendationStatusAction}>
                  <input type="hidden" name="recommendationId" value={row.id} />
                  <input
                    type="hidden"
                    name="status"
                    value={RecommendationStatus.DISMISSED}
                  />
                  <SubmitButton variant="ghost" size="sm" pendingLabel="Dismissing…">
                    <X />
                    Dismiss
                  </SubmitButton>
                </ActionForm>
                <Link
                  href={`/ops/content?project=${row.project.slug}`}
                  className={buttonClass("ghost", "sm")}
                >
                  Create a draft
                </Link>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-[12px] tabular text-ink">{value}</dd>
    </div>
  );
}

function rank(confidence: Confidence): number {
  return confidence === Confidence.HIGH ? 3 : confidence === Confidence.MEDIUM ? 2 : 1;
}
