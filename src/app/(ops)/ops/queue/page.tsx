import type { Metadata } from "next";
import Link from "next/link";
import { Gauge, PlayCircle, RefreshCw, RotateCcw } from "lucide-react";
import { prisma } from "@/server/db";
import { queueHealth } from "@/server/jobs/queues";
import { env } from "@/env";
import {
  retryJobAction,
  runJobNowAction,
  sweepJobsAction,
} from "@/app/actions/operations";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardHeader,
  EmptyState,
  ProjectDot,
  SectionLabel,
} from "@/components/ui/ops-primitives";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import {
  AdapterModeBadge,
  FailureCategoryBadge,
  JobStatusBadge,
  PlatformBadge,
  VerifiedBadge,
  failureHint,
  stageLabel,
} from "@/components/ui/status";
import { StatTile } from "@/components/charts/stat-tile";
import { dateTimeLabel, relativeTime } from "@/lib/utils";
import { JobStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Publish queue" };
export const dynamic = "force-dynamic";

type StepEntry = { at: string; message: string };

/**
 * The publishing worker's view: what is queued, what ran, what failed and the
 * exact step log for each attempt.
 */
export default async function QueuePage() {
  const [jobs, counts, redis] = await Promise.all([
    prisma.publishJob.findMany({
      orderBy: [{ runAt: "desc" }],
      take: 60,
      include: {
        attemptLog: { orderBy: { attemptNo: "desc" }, take: 1 },
        _count: { select: { attemptLog: true } },
        postPlatform: {
          include: {
            account: { select: { handle: true } },
            post: {
              include: {
                project: { select: { name: true, accentColor: true } },
                variant: { select: { hook: true } },
                asset: { select: { id: true, title: true } },
              },
            },
          },
        },
      },
    }),
    prisma.publishJob.groupBy({ by: ["status"], _count: { _all: true } }),
    queueHealth().catch(() => null),
  ]);

  const byStatus = (status: JobStatus) =>
    counts.find((row) => row.status === status)?._count._all ?? 0;

  return (
    <>
      <PageHeader
        title="Publish queue"
        description={
          env.enableLivePublishing
            ? "Live publishing is on: these jobs drive a real browser against real accounts."
            : "Simulation mode: jobs run the publish simulator, exercising the same queue, retry and idempotency paths without touching a live account."
        }
        actions={
          <ActionForm action={sweepJobsAction}>
            <SubmitButton variant="secondary" pendingLabel="Sweeping…">
              <RefreshCw />
              Reconcile queue
            </SubmitButton>
          </ActionForm>
        }
      />

      <PageBody className="space-y-4">
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <StatTile label="Pending" value={String(byStatus(JobStatus.PENDING))} />
          <StatTile label="Queued" value={String(byStatus(JobStatus.QUEUED))} tone="accent" />
          <StatTile label="Running" value={String(byStatus(JobStatus.RUNNING))} />
          <StatTile label="Succeeded" value={String(byStatus(JobStatus.SUCCEEDED))} />
          <StatTile
            label="Failed"
            value={String(byStatus(JobStatus.FAILED))}
            tone={byStatus(JobStatus.FAILED) > 0 ? "warning" : "neutral"}
          />
          <StatTile
            label="Gave up"
            value={String(byStatus(JobStatus.DEAD_LETTER))}
            tone={byStatus(JobStatus.DEAD_LETTER) > 0 ? "critical" : "neutral"}
          />
          <StatTile
            label="Blocked"
            value={String(byStatus(JobStatus.BLOCKED))}
            tone={byStatus(JobStatus.BLOCKED) > 0 ? "warning" : "neutral"}
            hint="account not connected"
          />
        </div>

        <Card>
          <CardHeader
            title="Redis queues"
            subtitle="Postgres is the source of truth; Redis is delivery. If they disagree, reconcile."
          />
          {redis === null ? (
            <div className="px-4 py-3.5">
              <p className="text-[12px] leading-relaxed text-[#f6c455]">
                Could not reach Redis at{" "}
                <code className="text-ink-secondary">{env.redisUrl}</code>. Jobs stay
                safely in Postgres and will be queued once it is back. Start it with{" "}
                <code className="text-ink-secondary">npm run db:up</code>.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-[11.5px]">
                <thead>
                  <tr className="border-b border-hairline text-[10.5px] uppercase tracking-wider text-ink-muted">
                    <th scope="col" className="px-4 py-2 font-semibold">Queue</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Waiting</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Active</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Delayed</th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">Failed</th>
                    <th scope="col" className="px-4 py-2 text-right font-semibold">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {redis.map((queue) => (
                    <tr key={queue.name} className="border-b border-hairline/60 last:border-0">
                      <td className="px-4 py-2 text-ink">{queue.name}</td>
                      <td className="px-3 py-2 text-right tabular text-ink-secondary">{queue.waiting}</td>
                      <td className="px-3 py-2 text-right tabular text-ink-secondary">{queue.active}</td>
                      <td className="px-3 py-2 text-right tabular text-ink-secondary">{queue.delayed}</td>
                      <td className="px-3 py-2 text-right tabular text-ink-secondary">{queue.failed}</td>
                      <td className="px-4 py-2 text-right tabular text-ink-secondary">{queue.completed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Jobs"
            subtitle="One job per destination. Its idempotency key is unique, so a retry can never publish the same content twice."
          />
          {jobs.length === 0 ? (
            <EmptyState
              icon={<Gauge />}
              title="No jobs yet"
              body="Approve and schedule a post to put the first job on the queue."
            />
          ) : (
            <ul className="divide-y divide-hairline">
              {jobs.map((job) => {
                const attempt = job.attemptLog[0];
                const steps = parseSteps(attempt?.steps);
                const target = job.postPlatform;
                const failed =
                  job.status === JobStatus.FAILED ||
                  job.status === JobStatus.DEAD_LETTER ||
                  job.status === JobStatus.BLOCKED;

                return (
                  <li key={job.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <JobStatusBadge status={job.status} />
                          <PlatformBadge platform={target.platform} />
                          <ProjectDot color={target.post.project.accentColor} />
                          <span className="text-[10.5px] text-ink-muted">
                            {target.post.project.name} · {target.account.handle}
                          </span>
                        </div>
                        <Link
                          href={`/ops/content/${target.post.asset.id}`}
                          className="mt-1.5 block truncate text-[12.5px] text-ink hover:underline"
                        >
                          {target.post.variant.hook}
                        </Link>
                        <p className="mt-0.5 text-[10.5px] tabular text-ink-muted">
                          Due {dateTimeLabel(job.runAt)} ({relativeTime(job.runAt)}) ·
                          attempt {job.attempts}/{job.maxAttempts} ·{" "}
                          {job._count.attemptLog} attempt
                          {job._count.attemptLog === 1 ? "" : "s"} logged
                        </p>

                        {/* Everything needed to trace one attempt end to end. */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {attempt?.adapterMode ? (
                            <AdapterModeBadge mode={attempt.adapterMode} />
                          ) : null}
                          {attempt ? (
                            <span className="text-[10px] text-ink-muted">
                              reached {stageLabel(attempt.stageReached)}
                            </span>
                          ) : null}
                          {attempt?.failureCategory ? (
                            <FailureCategoryBadge category={attempt.failureCategory} />
                          ) : null}
                          {target.status === "PUBLISHED" ? (
                            <VerifiedBadge
                              verifiedAt={target.verifiedAt}
                              method={target.verificationMethod}
                            />
                          ) : null}
                        </div>

                        {target.permalink ? (
                          <a
                            href={target.permalink}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-block break-all text-[10.5px] text-accent-ink hover:underline"
                          >
                            {target.permalink}
                          </a>
                        ) : null}
                        {target.remotePostId ? (
                          <p className="mt-0.5 text-[10px] tabular text-ink-muted">
                            platform post id{" "}
                            <code className="text-ink-secondary">{target.remotePostId}</code>
                            {target.platformAccountId
                              ? ` · account ${target.platformAccountId}`
                              : ""}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        {failed ? (
                          <ActionForm action={retryJobAction}>
                            <input type="hidden" name="jobId" value={job.id} />
                            <SubmitButton variant="secondary" size="sm" pendingLabel="Queueing…">
                              <RotateCcw />
                              Retry
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                        {job.status !== JobStatus.SUCCEEDED ? (
                          <ActionForm
                            action={runJobNowAction}
                            confirm={
                              env.enableLivePublishing
                                ? "Live publishing is enabled. This will publish to the real account now. Continue?"
                                : undefined
                            }
                          >
                            <input type="hidden" name="jobId" value={job.id} />
                            <SubmitButton variant="ghost" size="sm" pendingLabel="Running…">
                              <PlayCircle />
                              Run now
                            </SubmitButton>
                          </ActionForm>
                        ) : null}
                      </div>
                    </div>

                    {job.lastError ? (
                      <div className="mt-2 rounded-md border border-critical/30 bg-critical/8 px-2.5 py-1.5">
                        <p className="text-[11px] leading-relaxed text-[#ec7d7d]">
                          {job.lastError}
                        </p>
                        {attempt?.failureCategory ? (
                          <p className="mt-1 text-[10.5px] leading-relaxed text-ink-muted">
                            {failureHint(attempt.failureCategory)}
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    {steps.length > 0 ? (
                      <details className="mt-2 group">
                        <summary className="cursor-pointer list-none text-[10.5px] text-ink-muted transition-colors hover:text-ink-secondary">
                          <span className="group-open:hidden">
                            Show step log ({steps.length} steps)
                          </span>
                          <span className="hidden group-open:inline">Hide step log</span>
                        </summary>
                        <ol className="mt-1.5 space-y-0.5 rounded-md border border-hairline bg-surface-raised px-2.5 py-2">
                          {steps.map((step, index) => (
                            <li key={index} className="flex gap-2.5 text-[10.5px]">
                              <span className="shrink-0 tabular text-ink-muted">
                                {formatStepTime(step.at)}
                              </span>
                              <span className="text-ink-secondary">{step.message}</span>
                            </li>
                          ))}
                        </ol>
                        {attempt?.screenshotKey ? (
                          <a
                            href={`/api/media/${attempt.screenshotKey}`}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1.5 inline-block text-[10.5px] text-accent-ink hover:underline"
                          >
                            Open the failure screenshot
                          </a>
                        ) : null}
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Worker" />
          <div className="px-4 py-3.5">
            <SectionLabel>How to run it</SectionLabel>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-muted">
              The worker is a separate process:{" "}
              <code className="text-ink-secondary">npm run worker</code>. It consumes
              the queues above, sweeps due jobs every 60 seconds, and prunes expired
              sessions hourly. Without it, jobs stay queued — use{" "}
              <span className="text-ink-secondary">Run now</span> above to execute one
              in the web process instead. The same runner and the same idempotency
              guarantees apply either way.
            </p>
          </div>
        </Card>
      </PageBody>
    </>
  );
}

function parseSteps(value: unknown): StepEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is StepEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as StepEntry).message === "string",
  );
}

function formatStepTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "--:--:--"
    : date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
}
