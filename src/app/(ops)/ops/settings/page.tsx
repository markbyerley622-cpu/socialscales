import type { Metadata } from "next";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { prisma } from "@/server/db";
import { env } from "@/env";
import { queueHealth } from "@/server/jobs/queues";
import {
  effectivePublishingMode,
  readWorkerStatus,
} from "@/server/jobs/worker-status";
import { listAdapters } from "@/server/platforms/registry";
import { getAiProvider, listProviders } from "@/server/ai";
import { aiBoundaryStatus, formatUsd, recentAiSpend } from "@/server/ai/orchestration";
import { exists } from "@/server/storage";
import { setPublishPolicyAction } from "@/app/actions/operations";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Badge,
  Card,
  CardHeader,
  KeyValue,
  ProjectDot,
  SectionLabel,
} from "@/components/ui/ops-primitives";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import { CapabilityBadge, PolicyBadge } from "@/components/ui/status";
import { dateTimeLabel } from "@/lib/utils";
import { PublishPolicy } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const POLICY_DESCRIPTIONS: Record<PublishPolicy, string> = {
  MANUAL_APPROVAL:
    "Every post waits for a person before anything is queued. This is the default and the safest setting.",
  AUTO_PUBLISH:
    "Approved-by-policy posts are queued immediately for their scheduled time, with no human review.",
  SMART_APPROVAL:
    "A post skips review only when its scorecard averages 8 or better and every platform accepted the media with no warnings. Anything else goes to a person.",
};

/**
 * Settings and diagnostics on one screen: publishing policy per project, plus
 * everything a person needs to answer "why is nothing publishing?".
 */
export default async function SettingsPage() {
  const [worker, publishing, projects, redis, users, counts, storageCheck] =
    await Promise.all([
      readWorkerStatus(),
      effectivePublishingMode(),
      prisma.project.findMany({
      orderBy: { createdAt: "asc" },
      include: { brand: true, _count: { select: { accounts: true, assets: true, posts: true } } },
    }),
    queueHealth().catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    })),
    prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, name: true, role: true, lastLoginAt: true },
    }),
    Promise.all([
      prisma.contentAsset.count(),
      prisma.analyticsSnapshot.count(),
      prisma.publishJob.count(),
      prisma.activityLog.count(),
    ]),
    checkStorage(),
  ]);

  const [assetCount, snapshotCount, jobCount, activityCount] = counts;
  const aiStatus = aiBoundaryStatus();
  const aiSpend30d = await recentAiSpend(30);
  const redisOk = Array.isArray(redis);
  const provider = getAiProvider();

  return (
    <>
      <PageHeader
        title="Settings & diagnostics"
        description="Publishing policy per project, and the state of everything the pipeline depends on."
      />

      <PageBody className="space-y-4">
        {/* --- Diagnostics ------------------------------------------------ */}
        <Card>
          <CardHeader
            title="System check"
            subtitle="If publishing is not happening, the answer is on this list."
          />
          <ul className="divide-y divide-hairline">
            <CheckRow
              ok
              label="Database"
              detail={`Connected. ${assetCount} assets, ${snapshotCount} analytics snapshots, ${jobCount} publish jobs, ${activityCount} activity events.`}
            />
            <CheckRow
              ok={redisOk}
              label="Redis / job queues"
              detail={
                redisOk
                  ? `Reachable at ${env.redisUrl}. Queues: ${(redis as Array<{ name: string }>).map((queue) => queue.name).join(", ")}.`
                  : `Unreachable at ${env.redisUrl}. Jobs stay in Postgres and will be queued once it is back — start it with \`npm run db:up\`. Error: ${(redis as { error: string }).error}`
              }
              warnOnly
            />
            <CheckRow
              ok={storageCheck.ok}
              label="Media storage"
              detail={
                storageCheck.ok
                  ? `All ${storageCheck.checked} sampled files are present under ${env.storageDir}.`
                  : `${storageCheck.missing} of ${storageCheck.checked} sampled files are missing from ${env.storageDir}. The database references files that are not on disk.`
              }
            />
            <CheckRow
              ok={worker?.online ?? false}
              okLabel="Online"
              failLabel="Not running"
              warnOnly
              label="Publishing worker"
              detail={
                worker
                  ? worker.online
                    ? `Checked in ${dateTimeLabel(worker.lastSeenAt)}${worker.hostname ? ` from ${worker.hostname}` : ""}, up since ${dateTimeLabel(worker.startedAt)}. Queue prefix "${worker.queuePrefix}".`
                    : `Last checked in ${dateTimeLabel(worker.lastSeenAt)} and has gone quiet. Nothing will publish until it is running again — start it with \`npm run worker\`.`
                  : "No worker has ever checked in. Scheduled posts will sit in the queue until one runs."
              }
            />
            <CheckRow
              ok={!publishing.live}
              okLabel="Simulation"
              failLabel="LIVE"
              warnOnly
              label="Publishing mode"
              detail={
                (publishing.live
                  ? "Publishing is LIVE: the worker drives real browsers against real accounts."
                  : "Simulation: the worker runs the publish simulator, and every metric it produces is stamped SIMULATED.") +
                (publishing.source === "worker"
                  ? " Reported by the worker itself, which is what actually publishes."
                  : " No worker has checked in, so this reflects this web process's own configuration and may not match the worker's.") +
                (publishing.disagrees
                  ? ` This web process is configured for ${env.enableLivePublishing ? "live publishing" : "simulation"}, which disagrees with the worker. The worker decides.`
                  : "")
              }
            />
            <CheckRow
              ok
              label="AI provider"
              detail={`${provider.name} (${provider.model}). Transcription: ${provider.canTranscribe ? "supported" : "not supported"}. Available: ${listProviders().join(", ")}.`}
            />
            <CheckRow
              ok
              okLabel={aiStatus.modelActive ? "Model" : "Rules"}
              warnOnly={!aiStatus.modelActive}
              label="AI orchestration boundary"
              detail={`${aiStatus.headline} Last 30 days: ${aiSpend30d.jobs} jobs, ${aiSpend30d.attempts} provider attempts, ${formatUsd(aiSpend30d.costUsd)}.`}
            />
            <CheckRow
              ok={!env.playwrightHeadless}
              okLabel="Headed"
              failLabel="Headless"
              warnOnly
              label="Browser mode for connecting accounts"
              detail={
                env.playwrightHeadless
                  ? "PLAYWRIGHT_HEADLESS is on, which makes the manual sign-in flow unusable — nobody can see the window. Set it to 0 before connecting an account."
                  : "A visible browser window opens for account connection, which is what the manual sign-in needs."
              }
            />
          </ul>
        </Card>

        {/* --- Publishing policy ----------------------------------------- */}
        <Card>
          <CardHeader
            title="Publishing policy"
            subtitle="How much human involvement each project requires. Manual approval is the default."
          />
          <ul className="divide-y divide-hairline">
            {projects.map((project) => (
              <li key={project.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <ProjectDot color={project.accentColor} />
                      <span className="text-[13px] font-medium text-ink">
                        {project.name}
                      </span>
                      <PolicyBadge policy={project.publishPolicy} />
                    </div>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                      {POLICY_DESCRIPTIONS[project.publishPolicy]}
                    </p>
                    <p className="mt-1 text-[10.5px] tabular text-ink-muted">
                      {project._count.assets} assets · {project._count.posts} posts ·{" "}
                      {project._count.accounts} accounts · {project.timezone}
                    </p>
                  </div>

                  <ActionForm
                    action={setPublishPolicyAction}
                    className="flex shrink-0 items-end gap-2"
                    confirm="Changing this affects how future posts are reviewed. Continue?"
                  >
                    <input type="hidden" name="projectId" value={project.id} />
                    <label className="block">
                      <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-muted">
                        Policy
                      </span>
                      <select
                        name="publishPolicy"
                        defaultValue={project.publishPolicy}
                        className="h-8 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink"
                      >
                        {Object.values(PublishPolicy).map((policy) => (
                          <option key={policy} value={policy}>
                            {policy.replace(/_/g, " ").toLowerCase()}
                          </option>
                        ))}
                      </select>
                    </label>
                    <SubmitButton variant="secondary" pendingLabel="Saving…">
                      Save
                    </SubmitButton>
                  </ActionForm>
                </div>

                {project.brand ? (
                  <dl className="mt-3 grid gap-3 border-t border-hairline pt-3 sm:grid-cols-2 lg:grid-cols-4">
                    <KeyValue label="Audience">{project.brand.audience}</KeyValue>
                    <KeyValue label="Tone">{project.brand.tone}</KeyValue>
                    <KeyValue label="Primary CTA">{project.brand.primaryCta}</KeyValue>
                    <KeyValue label="Banned phrases">
                      {project.brand.bannedPhrases.length > 0
                        ? project.brand.bannedPhrases.join(", ")
                        : "none"}
                    </KeyValue>
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>

        {/* --- Platform capability matrix -------------------------------- */}
        <Card>
          <CardHeader
            title="Platform operations"
            subtitle="API-based versus browser-assisted, per operation, as declared by each adapter."
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-[11.5px]">
              <thead>
                <tr className="border-b border-hairline text-[10.5px] uppercase tracking-wider text-ink-muted">
                  <th scope="col" className="px-4 py-2 font-semibold">Platform</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Upload</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Publish</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Native schedule</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Metrics</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Status check</th>
                </tr>
              </thead>
              <tbody>
                {listAdapters().map((adapter) => (
                  <tr key={adapter.platform} className="border-b border-hairline/60 last:border-0">
                    <td className="px-4 py-2.5 text-ink">{adapter.label}</td>
                    <td className="px-3 py-2.5"><CapabilityBadge mode={adapter.capabilities.upload} /></td>
                    <td className="px-3 py-2.5"><CapabilityBadge mode={adapter.capabilities.publish} /></td>
                    <td className="px-3 py-2.5"><CapabilityBadge mode={adapter.capabilities.nativeSchedule} /></td>
                    <td className="px-3 py-2.5"><CapabilityBadge mode={adapter.capabilities.metrics} /></td>
                    <td className="px-4 py-2.5"><CapabilityBadge mode={adapter.capabilities.checkStatus} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* --- Operators ------------------------------------------------- */}
        <Card>
          <CardHeader
            title="Operators"
            subtitle="Accounts that can sign in. Passwords are stored as scrypt hashes; sessions as SHA-256 hashes of an opaque token."
          />
          <ul className="divide-y divide-hairline">
            {users.map((user) => (
              <li key={user.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="text-[12.5px] text-ink">{user.name}</span>
                <span className="text-[11px] text-ink-muted">{user.email}</span>
                <Badge tone="neutral">{user.role.toLowerCase()}</Badge>
                <span className="ml-auto text-[10.5px] tabular text-ink-muted">
                  {user.lastLoginAt
                    ? `last signed in ${dateTimeLabel(user.lastLoginAt)}`
                    : "never signed in"}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        {/* --- What this system will not do ------------------------------ */}
        <Card>
          <CardHeader title="Deliberate limits" />
          <div className="px-4 py-3.5">
            <SectionLabel>Not implemented, by design</SectionLabel>
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {[
                "No CAPTCHA solving or challenge bypass",
                "No browser fingerprint spoofing or stealth plugins",
                "No purchased views, likes or followers",
                "No automated commenting, following or liking",
                "No mass DMs",
                "No account creation",
                "No scraping of private data",
                "No predicted virality score",
              ].map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-secondary"
                >
                  <XCircle className="mt-0.5 size-3.5 shrink-0 text-ink-muted" />
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-muted">
              If a platform presents a verification step during a publish, the run
              fails, preserves what it saw, and asks a person to finish it.
            </p>
          </div>
        </Card>
      </PageBody>
    </>
  );
}

function CheckRow({
  ok,
  label,
  detail,
  warnOnly = false,
  okLabel = "OK",
  failLabel,
}: {
  ok: boolean;
  label: string;
  detail: string;
  /** A failure here degrades the system rather than breaking it. */
  warnOnly?: boolean;
  okLabel?: string;
  failLabel?: string;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <span className="mt-0.5 shrink-0">
        {ok ? (
          <CheckCircle2 className="size-4 text-good" />
        ) : warnOnly ? (
          <AlertTriangle className="size-4 text-warning" />
        ) : (
          <XCircle className="size-4 text-critical" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12.5px] font-medium text-ink">{label}</span>
          <Badge tone={ok ? "good" : warnOnly ? "warning" : "critical"}>
            {ok ? okLabel : (failLabel ?? "Problem")}
          </Badge>
        </div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{detail}</p>
      </div>
    </li>
  );
}

/**
 * Samples recent assets and confirms their bytes are still on disk. A database
 * row pointing at a missing file is the failure this catches.
 */
async function checkStorage(): Promise<{
  ok: boolean;
  checked: number;
  missing: number;
}> {
  const assets = await prisma.contentAsset.findMany({
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { storageKey: true },
  });

  let missing = 0;
  for (const asset of assets) {
    if (!(await exists(asset.storageKey))) missing += 1;
  }
  return { ok: missing === 0, checked: assets.length, missing };
}
