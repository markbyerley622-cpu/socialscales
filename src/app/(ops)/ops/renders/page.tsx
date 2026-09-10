import type { Metadata } from "next";
import Link from "next/link";
import { Clapperboard, TriangleAlert } from "lucide-react";
import { prisma } from "@/server/db";
import { ffmpegProvider, rendersForProject } from "@/server/rendering";
import { cancelRenderAction, renderVariantAction } from "@/app/actions/posts";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import type { BadgeTone } from "@/components/ui/ops-primitives";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ProjectDot,
} from "@/components/ui/ops-primitives";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import { dateTimeLabel, duration } from "@/lib/utils";
import { RenderStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Renders" };
export const dynamic = "force-dynamic";

/**
 * Render jobs across a project.
 *
 * Rendering runs in the worker, which means an operator queues one and then goes
 * somewhere else. Without a screen like this, a job that is queued, running,
 * stalled or failed is invisible until someone happens to reopen the exact
 * variant it belongs to.
 */
export default async function RendersPage({
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
        <PageHeader title="Renders" description="Cuts produced from treatments." />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Clapperboard />}
              title="No projects yet"
              body="Renders belong to a project. Create one first."
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const selected =
    projects.find((project) => project.slug === params.project) ?? projects[0]!;

  const [jobs, availability] = await Promise.all([
    rendersForProject(selected.id),
    ffmpegProvider.availability(),
  ]);

  return (
    <>
      <PageHeader
        title="Renders"
        description="Treatments turned into real vertical MP4s. Rendering happens in the worker, so a queued job survives closing this tab."
      />

      <PageBody className="space-y-4">
        {projects.length > 1 ? (
          <nav className="flex flex-wrap items-center gap-1.5" aria-label="Project">
            {projects.map((project) => (
              <a
                key={project.id}
                href={`/ops/renders?project=${project.slug}`}
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

        {!availability.available ? (
          <Card>
            <div className="flex items-start gap-2.5 px-4 py-3">
              <Badge tone="critical" icon={<TriangleAlert />}>
                Renderer unavailable
              </Badge>
              <p className="text-[11.5px] leading-relaxed text-ink-secondary">
                {availability.reason} Queued renders will stay queued until this is
                fixed — nothing is lost, but nothing will encode either.
              </p>
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title={`${jobs.length} render${jobs.length === 1 ? "" : "s"}`}
            subtitle={
              availability.available
                ? `Local FFmpeg ${availability.version}. Output is 1080×1920 H.264/AAC, probed before it is accepted.`
                : "The local renderer is not usable right now."
            }
          />
          {jobs.length === 0 ? (
            <EmptyState
              icon={<Clapperboard />}
              title="Nothing rendered yet"
              body="Open a variant with a treatment and render it. The cut appears here and on the variant itself."
            />
          ) : (
            <ul className="divide-y divide-hairline">
              {jobs.map((job) => (
                <li key={job.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={toneFor(job.status)}>{job.status}</Badge>
                        <Link
                          href={`/ops/content/${job.variant.assetId}`}
                          className="text-[12.5px] font-medium text-ink hover:underline"
                        >
                          {job.variant.label}
                        </Link>
                        {job.status === RenderStatus.RUNNING ||
                        job.status === RenderStatus.PENDING ? (
                          <span className="tabular text-[10.5px] text-ink-muted">
                            {job.stage.toLowerCase()} · {job.progress}%
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-[11.5px] text-ink-secondary">
                        {job.variant.hook}
                      </p>
                      <p className="mt-0.5 text-[10.5px] tabular text-ink-muted">
                        {dateTimeLabel(job.createdAt)}
                        {job.attempts > 1 ? ` · ${job.attempts} attempts` : ""}
                        {job.durationMs
                          ? ` · rendered in ${(job.durationMs / 1000).toFixed(1)}s`
                          : ""}
                        {job.outputAsset?.durationSeconds
                          ? ` · ${duration(job.outputAsset.durationSeconds)}`
                          : ""}
                      </p>
                      {job.status === RenderStatus.FAILED ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-[#ec7d7d]">
                          {job.errorKind} at {job.failureStage?.toLowerCase()} —{" "}
                          {job.error}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {job.outputAsset ? (
                        <video
                          controls
                          preload="metadata"
                          playsInline
                          src={`/api/media/${job.outputAsset.storageKey}`}
                          className="h-28 rounded-md border border-hairline bg-black"
                        />
                      ) : null}
                      {job.status === RenderStatus.RUNNING ||
                      job.status === RenderStatus.PENDING ? (
                        <ActionForm action={cancelRenderAction}>
                          <input type="hidden" name="renderJobId" value={job.id} />
                          <SubmitButton variant="ghost" size="sm" pendingLabel="…">
                            Cancel
                          </SubmitButton>
                        </ActionForm>
                      ) : job.status === RenderStatus.FAILED ||
                        job.status === RenderStatus.CANCELLED ? (
                        <ActionForm action={renderVariantAction}>
                          <input type="hidden" name="variantId" value={job.variant.id} />
                          <SubmitButton variant="ghost" size="sm" pendingLabel="…">
                            Retry
                          </SubmitButton>
                        </ActionForm>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  );
}

function toneFor(status: RenderStatus): BadgeTone {
  if (status === RenderStatus.SUCCEEDED) return "good";
  if (status === RenderStatus.FAILED) return "critical";
  if (status === RenderStatus.RUNNING) return "accent";
  if (status === RenderStatus.CANCELLED) return "neutral";
  return "warning";
}
