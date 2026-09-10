import type { Metadata } from "next";
import Link from "next/link";
import {
  CheckCircle2,
  Download,
  Radio,
  Scissors,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { prisma } from "@/server/db";
import {
  distributionsForProject,
  undistributedRenders,
} from "@/server/distribution";
import { getAdapter } from "@/server/platforms/registry";
import {
  assessDistributionAction,
  dispatchDistributionAction,
  exportDistributionAction,
  optimizeDistributionAction,
} from "@/app/actions/operations";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import type { BadgeTone } from "@/components/ui/ops-primitives";
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
import { CopyButton } from "@/components/content/copy-button";
import { PlatformBadge, platformLabel } from "@/components/ui/status";
import { dateTimeLabel, duration } from "@/lib/utils";
import { DistributionFit, DistributionStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Distribution" };
export const dynamic = "force-dynamic";

/**
 * Where a finished cut goes.
 *
 * The screen has to make one distinction obvious: a destination that can publish
 * itself, and one that needs a person. Both are legitimate outcomes, and the
 * manual one is only useful if what a person pastes is the same text the
 * automated path would have sent — so the composed caption is shown, not the raw
 * variant copy.
 */
export default async function DistributionPage({
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
        <PageHeader title="Distribution" description="Where a finished cut goes." />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Radio />}
              title="No projects yet"
              body="Distribution belongs to a project. Create one first."
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const selected =
    projects.find((project) => project.slug === params.project) ?? projects[0]!;

  const [rows, pending] = await Promise.all([
    distributionsForProject(selected.id),
    undistributedRenders(selected.id),
  ]);

  // Grouped by cut: one file usually goes to several places, and the decision
  // per place only makes sense next to the others.
  const byAsset = new Map<string, typeof rows>();
  for (const row of rows) {
    byAsset.set(row.assetId, [...(byAsset.get(row.assetId) ?? []), row]);
  }

  return (
    <>
      <PageHeader
        title="Distribution"
        description="Each rendered cut, checked against every destination's own limits, then either handed to the automated publisher or packaged for a person."
      />

      <PageBody className="space-y-4">
        {projects.length > 1 ? (
          <nav className="flex flex-wrap items-center gap-1.5" aria-label="Project">
            {projects.map((project) => (
              <a
                key={project.id}
                href={`/ops/distribution?project=${project.slug}`}
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

        {pending.length > 0 ? (
          <Card>
            <CardHeader
              title={`${pending.length} rendered cut${pending.length === 1 ? "" : "s"} not assessed`}
              subtitle="Assessing checks the file against each connected platform's declared limits, and composes the caption the way that platform wants it."
            />
            <ul className="divide-y divide-hairline">
              {pending.map((asset) => (
                <li
                  key={asset.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/ops/content/${asset.id}`}
                      className="text-[12.5px] text-ink hover:underline"
                    >
                      {asset.title}
                    </Link>
                    <p className="text-[11px] tabular text-ink-muted">
                      {duration(asset.durationSeconds)} · rendered{" "}
                      {dateTimeLabel(asset.createdAt)}
                    </p>
                  </div>
                  <AssessForm assetId={asset.id} />
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {byAsset.size === 0 ? (
          <Card>
            <EmptyState
              icon={<Radio />}
              title="Nothing distributed yet"
              body="Render a cut, then assess it here. A destination is never dispatched or exported while it does not fit — that is what assessing is for."
            />
          </Card>
        ) : null}

        {[...byAsset.entries()].map(([assetId, targets]) => {
          const first = targets[0]!;
          const readyAutomatable = targets.filter(
            (target) =>
              target.fit === DistributionFit.READY &&
              target.status === DistributionStatus.ASSESSED &&
              getAdapter(target.platform).capabilities.publish !== "UNSUPPORTED",
          );

          return (
            <Card key={assetId}>
              <CardHeader
                title={first.variant.label}
                subtitle={`${first.variant.hook} · ${duration(first.asset.durationSeconds)}`}
                action={
                  first.asset.storageKey ? (
                    <video
                      controls
                      preload="metadata"
                      playsInline
                      src={`/api/media/${first.asset.storageKey}`}
                      className="h-24 rounded-md border border-hairline bg-black"
                    />
                  ) : null
                }
              />

              <ul className="divide-y divide-hairline">
                {targets.map((target) => {
                  const adapter = getAdapter(target.platform);
                  const automatable = adapter.capabilities.publish !== "UNSUPPORTED";
                  const issues =
                    (target.issues as Array<{ severity: string; message: string }> | null) ??
                    [];

                  return (
                    <li key={target.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <PlatformBadge platform={target.platform} />
                        <Badge tone={fitTone(target.fit)} icon={fitIcon(target.fit)}>
                          {target.fit.replace(/_/g, " ").toLowerCase()}
                        </Badge>
                        <Badge tone={statusTone(target.status)}>{target.status}</Badge>
                        {!automatable ? (
                          <span className="text-[10.5px] text-ink-muted">
                            manual upload only — no automated publish path here
                          </span>
                        ) : null}
                        {target.post ? (
                          <Link
                            href="/ops/queue"
                            className="text-[10.5px] text-accent-ink hover:underline"
                          >
                            post {target.post.status.toLowerCase()}
                            {target.post.scheduledFor
                              ? ` for ${dateTimeLabel(target.post.scheduledFor)}`
                              : ""}
                          </Link>
                        ) : null}
                        {target.exportedAt ? (
                          <span className="text-[10.5px] text-ink-muted">
                            exported {dateTimeLabel(target.exportedAt)}
                          </span>
                        ) : null}
                      </div>

                      {issues.length > 0 ? (
                        <ul className="mt-1.5 space-y-0.5">
                          {issues.map((issue, index) => (
                            <li
                              key={index}
                              className={
                                issue.severity === "error"
                                  ? "text-[10.5px] leading-relaxed text-[#ec7d7d]"
                                  : "text-[10.5px] leading-relaxed text-ink-muted"
                              }
                            >
                              · {issue.message}
                            </li>
                          ))}
                        </ul>
                      ) : null}

                      {target.status === DistributionStatus.EXPORTED ? (
                        <div className="mt-2 space-y-1.5 rounded-md border border-hairline bg-surface-raised p-2.5">
                          <SectionLabel>
                            Paste this into {platformLabel(target.platform)}
                          </SectionLabel>
                          <p className="whitespace-pre-line text-[11.5px] leading-relaxed text-ink">
                            {target.caption}
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <CopyButton text={target.caption} label="Copy caption" />
                            <a
                              href={`/api/media/${target.asset.storageKey}`}
                              download
                              className="inline-flex items-center gap-1.5 text-[11px] text-accent-ink hover:underline"
                            >
                              <Download className="size-3" />
                              Download the file
                            </a>
                            <a
                              href={adapter.composerUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-[11px] text-accent-ink hover:underline"
                            >
                              Open {adapter.label}
                            </a>
                          </div>
                        </div>
                      ) : null}

                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {target.fit === DistributionFit.NEEDS_OPTIMIZATION &&
                        target.status !== DistributionStatus.OPTIMIZING ? (
                          <ActionForm action={optimizeDistributionAction}>
                            <input type="hidden" name="distributionId" value={target.id} />
                            <SubmitButton variant="ghost" size="sm" pendingLabel="Queueing…">
                              <Scissors />
                              Render a shorter cut
                            </SubmitButton>
                          </ActionForm>
                        ) : null}

                        {target.fit === DistributionFit.READY &&
                        target.status === DistributionStatus.ASSESSED ? (
                          <ActionForm action={exportDistributionAction}>
                            <input type="hidden" name="distributionId" value={target.id} />
                            <SubmitButton variant="ghost" size="sm" pendingLabel="Preparing…">
                              <Download />
                              Export for a manual upload
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>

              {readyAutomatable.length > 0 ? (
                <div className="border-t border-hairline px-4 py-3">
                  <ActionForm
                    action={dispatchDistributionAction}
                    className="flex flex-wrap items-end gap-2"
                  >
                    <input type="hidden" name="assetId" value={assetId} />
                    <input type="hidden" name="variantId" value={first.variantId} />
                    {readyAutomatable.map((target) => (
                      <input
                        key={target.id}
                        type="hidden"
                        name="platform"
                        value={target.platform}
                      />
                    ))}
                    <label className="flex flex-col gap-1">
                      <SectionLabel>Publish at</SectionLabel>
                      <input
                        type="datetime-local"
                        name="scheduledFor"
                        className="rounded-md border border-hairline bg-surface-raised px-2 py-1.5 text-[12px] text-ink"
                      />
                    </label>
                    <SubmitButton pendingLabel="Dispatching…">
                      <Radio />
                      Dispatch to{" "}
                      {readyAutomatable.map((t) => platformLabel(t.platform)).join(", ")}
                    </SubmitButton>
                  </ActionForm>
                  <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-muted">
                    This creates an ordinary post on the rendered cut, so the project&apos;s
                    approval policy, the schedule and the publishing worker all apply
                    exactly as they do for an uploaded file.
                  </p>
                </div>
              ) : null}
            </Card>
          );
        })}
      </PageBody>
    </>
  );
}

/**
 * A cut needs a variant to carry its caption.
 *
 * For a rendered cut that is the variant whose treatment produced it, which the
 * render job records directly. The fallback covers a cut that was uploaded
 * rather than rendered.
 */
async function AssessForm({ assetId }: { assetId: string }) {
  const job = await prisma.renderJob.findFirst({
    where: { outputAssetId: assetId },
    select: { variantId: true },
  });
  const variantId =
    job?.variantId ??
    (
      await prisma.contentVariant.findFirst({
        where: { assetId },
        select: { id: true },
      })
    )?.id ??
    null;

  if (!variantId) {
    return (
      <span className="text-[10.5px] text-ink-muted">
        No variant is attached to this cut, so there is no caption to send with it.
      </span>
    );
  }

  return (
    <ActionForm action={assessDistributionAction}>
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="variantId" value={variantId} />
      <SubmitButton variant="ghost" size="sm" pendingLabel="Assessing…">
        Assess destinations
      </SubmitButton>
    </ActionForm>
  );
}

function fitTone(fit: DistributionFit): BadgeTone {
  if (fit === DistributionFit.READY) return "good";
  if (fit === DistributionFit.NEEDS_OPTIMIZATION) return "warning";
  return "critical";
}

function fitIcon(fit: DistributionFit) {
  if (fit === DistributionFit.READY) return <CheckCircle2 />;
  if (fit === DistributionFit.NEEDS_OPTIMIZATION) return <TriangleAlert />;
  return <XCircle />;
}

function statusTone(status: DistributionStatus): BadgeTone {
  if (status === DistributionStatus.DISPATCHED) return "accent";
  if (status === DistributionStatus.EXPORTED) return "info";
  if (status === DistributionStatus.OPTIMIZING) return "warning";
  if (status === DistributionStatus.CANCELLED) return "neutral";
  return "neutral";
}
