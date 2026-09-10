import type { Metadata } from "next";
import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { prisma } from "@/server/db";
import { loadPostFacts, median, type PostFact } from "@/server/analytics/aggregate";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ProjectDot,
  SectionLabel,
} from "@/components/ui/primitives";
import { compactNumber, humanize, percent, relativeTime } from "@/lib/utils";
import { ExperimentRole } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Experiments" };
export const dynamic = "force-dynamic";

/**
 * A/B results computed live from published performance.
 *
 * A winner is only declared when both arms have at least MIN_ARM published
 * destinations and the difference on the experiment's chosen metric exceeds
 * MIN_SEPARATION. Otherwise the experiment says so, rather than crowning the arm
 * that happens to be ahead.
 */
const MIN_ARM = 3;
const MIN_SEPARATION = 0.15;

export default async function ExperimentsPage() {
  const [experiments, facts] = await Promise.all([
    prisma.experiment.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        project: { select: { name: true, accentColor: true } },
        variants: {
          include: {
            variant: {
              select: { id: true, hook: true, label: true, assetId: true },
            },
          },
        },
      },
    }),
    loadPostFacts(),
  ]);

  return (
    <>
      <PageHeader
        title="Experiments"
        description="Head-to-head tests on the same asset. Results are computed from the published posts of each arm, not entered by hand."
      />

      <PageBody className="space-y-4">
        {experiments.length === 0 ? (
          <Card>
            <EmptyState
              icon={<FlaskConical />}
              title="No experiments yet"
              body="Write two copy variants for one asset, publish both, and the comparison appears here."
            />
          </Card>
        ) : (
          experiments.map((experiment) => {
            const arms = experiment.variants.map((entry) => {
              const armFacts = facts.filter(
                (fact) => fact.hook === entry.variant.hook,
              );
              return {
                role: entry.role,
                label: entry.variant.label,
                hook: entry.variant.hook,
                assetId: entry.variant.assetId,
                facts: armFacts,
                metric: metricValue(armFacts, experiment.metric),
                sampleSize: armFacts.length,
              };
            });

            const control = arms.find((arm) => arm.role === ExperimentRole.CONTROL);
            const variant = arms.find((arm) => arm.role === ExperimentRole.VARIANT);
            const verdict = decide(control, variant, experiment.metric);

            return (
              <Card key={experiment.id}>
                <CardHeader
                  title={
                    <span className="inline-flex items-center gap-2">
                      <ProjectDot color={experiment.project.accentColor} />
                      {experiment.name}
                    </span>
                  }
                  subtitle={`${experiment.project.name} · deciding on ${metricLabel(experiment.metric)} · started ${
                    experiment.startedAt ? relativeTime(experiment.startedAt) : "not yet"
                  }`}
                  action={<Badge tone="neutral">{humanize(experiment.status)}</Badge>}
                />

                <div className="px-4 py-3.5">
                  <SectionLabel>Hypothesis</SectionLabel>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                    {experiment.hypothesis}
                  </p>

                  <div className="mt-3.5 grid gap-3 sm:grid-cols-2">
                    {arms.map((arm) => (
                      <div
                        key={arm.role}
                        className={`rounded-md border px-3 py-2.5 ${
                          verdict.winner === arm.role
                            ? "border-above/45 bg-above/8"
                            : "border-hairline bg-surface-raised"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Badge tone={arm.role === ExperimentRole.CONTROL ? "neutral" : "accent"}>
                            {arm.role === ExperimentRole.CONTROL ? "Control" : "Variant"}
                          </Badge>
                          {verdict.winner === arm.role ? (
                            <Badge tone="info">Ahead</Badge>
                          ) : null}
                        </div>
                        <Link
                          href={`/content/${arm.assetId}`}
                          className="mt-2 block text-[12.5px] leading-snug text-ink hover:underline"
                        >
                          {arm.hook}
                        </Link>
                        <dl className="mt-2.5 space-y-1">
                          <Stat
                            label={metricLabel(experiment.metric)}
                            value={formatMetric(arm.metric, experiment.metric)}
                          />
                          <Stat label="Posts" value={String(arm.sampleSize)} />
                          <Stat
                            label="Median views"
                            value={compactNumber(median(arm.facts.map((f) => f.views)))}
                          />
                          <Stat
                            label="Completion"
                            value={
                              arm.facts.length > 0
                                ? percent(
                                    arm.facts.reduce((s, f) => s + f.completionRate, 0) /
                                      arm.facts.length,
                                    0,
                                  )
                                : "—"
                            }
                          />
                        </dl>
                      </div>
                    ))}
                  </div>

                  <div
                    className={`mt-3 rounded-md border px-3 py-2.5 ${
                      verdict.decided
                        ? "border-good/35 bg-good/8"
                        : "border-hairline bg-surface-raised"
                    }`}
                  >
                    <SectionLabel>Verdict</SectionLabel>
                    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">
                      {verdict.message}
                    </p>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </PageBody>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[10.5px] text-ink-muted">{label}</dt>
      <dd className="text-[11.5px] tabular text-ink">{value}</dd>
    </div>
  );
}

type Arm = {
  role: ExperimentRole;
  sampleSize: number;
  metric: number;
} | undefined;

function decide(
  control: Arm,
  variant: Arm,
  metric: string,
): { decided: boolean; winner: ExperimentRole | null; message: string } {
  if (!control || !variant) {
    return {
      decided: false,
      winner: null,
      message: "This experiment is missing an arm, so nothing can be compared.",
    };
  }
  if (control.sampleSize < MIN_ARM || variant.sampleSize < MIN_ARM) {
    return {
      decided: false,
      winner: null,
      message: `Not enough data: ${control.sampleSize} control and ${variant.sampleSize} variant posts, against a minimum of ${MIN_ARM} each. Publish more of both before reading anything into the numbers above.`,
    };
  }
  if (control.metric === 0) {
    return {
      decided: false,
      winner: null,
      message: "The control arm has no measurable result on this metric yet.",
    };
  }

  const ratio = variant.metric / control.metric;
  const separation = Math.abs(ratio - 1);

  if (separation < MIN_SEPARATION) {
    return {
      decided: false,
      winner: null,
      message: `Too close to call: the variant is ${(separation * 100).toFixed(0)}% from the control on ${metricLabel(metric)}, below the ${Math.round(MIN_SEPARATION * 100)}% separation this system requires before declaring a winner.`,
    };
  }

  const winner = ratio > 1 ? ExperimentRole.VARIANT : ExperimentRole.CONTROL;
  return {
    decided: true,
    winner,
    message: `${winner === ExperimentRole.VARIANT ? "The variant" : "The control"} is ahead by ${(separation * 100).toFixed(0)}% on ${metricLabel(metric)}, across ${control.sampleSize} control and ${variant.sampleSize} variant posts. That clears the separation threshold, though with samples this size it is a direction rather than a certainty.`,
  };
}

function metricValue(facts: PostFact[], metric: string): number {
  if (facts.length === 0) return 0;
  switch (metric) {
    case "completionRate":
      return facts.reduce((sum, fact) => sum + fact.completionRate, 0) / facts.length;
    case "profileVisits":
      return facts.reduce((sum, fact) => sum + fact.profileVisits, 0) / facts.length;
    case "conversions":
      return facts.reduce((sum, fact) => sum + fact.conversions, 0) / facts.length;
    case "engagementRate":
      return facts.reduce((sum, fact) => sum + fact.engagementRate, 0) / facts.length;
    default:
      return median(facts.map((fact) => fact.views));
  }
}

function metricLabel(metric: string): string {
  switch (metric) {
    case "completionRate":
      return "mean completion";
    case "profileVisits":
      return "mean profile visits";
    case "conversions":
      return "mean conversions";
    case "engagementRate":
      return "mean engagement rate";
    default:
      return "median views";
  }
}

function formatMetric(value: number, metric: string): string {
  if (metric === "completionRate" || metric === "engagementRate") {
    return percent(value, 1);
  }
  return compactNumber(value);
}
