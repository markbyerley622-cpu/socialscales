import type { Metadata } from "next";
import { Link2, Plug, Trash2, Users } from "lucide-react";
import { prisma } from "@/server/db";
import { listAdapters, getAdapter } from "@/server/platforms/registry";
import { env } from "@/env";
import {
  addAccountAction,
  connectAccountAction,
  disconnectAccountAction,
  verifyAccountAction,
} from "@/app/actions/operations";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardHeader,
  EmptyState,
  ProjectDot,
  SectionLabel,
} from "@/components/ui/primitives";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import {
  AccountStatusBadge,
  CapabilityBadge,
  PlatformBadge,
  platformLabel,
} from "@/components/ui/status";
import { dateTimeLabel, relativeTime } from "@/lib/utils";
import { AccountStatus, Platform } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Accounts" };
export const dynamic = "force-dynamic";

/**
 * Account and session management.
 *
 * The connect flow is explicit about what it does and does not do: a browser
 * opens, a human signs in, and only the resulting session blob is kept —
 * encrypted, with no password ever passing through this system.
 */
export default async function AccountsPage() {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      accounts: {
        orderBy: [{ platform: "asc" }, { handle: "asc" }],
        include: {
          session: {
            select: { capturedAt: true, lastVerifiedAt: true, status: true },
          },
          _count: { select: { postPlatforms: true } },
        },
      },
    },
  });

  return (
    <>
      <PageHeader
        title="Accounts"
        description="One social account per project per platform. Connecting stores an encrypted browser session; passwords are never seen or saved by this system."
      />

      <PageBody className="space-y-4">
        <Card>
          <CardHeader
            title="How publishing reaches each platform"
            subtitle="What is API-based versus browser-assisted, declared by each adapter rather than assumed."
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-[11.5px]">
              <thead>
                <tr className="border-b border-hairline text-[10.5px] uppercase tracking-wider text-ink-muted">
                  <th scope="col" className="px-4 py-2 font-semibold">Platform</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Publish</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Own scheduler</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Metrics</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Limits</th>
                </tr>
              </thead>
              <tbody>
                {listAdapters().map((adapter) => (
                  <tr
                    key={adapter.platform}
                    className="border-b border-hairline/60 last:border-0"
                  >
                    <td className="px-4 py-2.5">
                      <PlatformBadge platform={adapter.platform} />
                    </td>
                    <td className="px-3 py-2.5">
                      <CapabilityBadge mode={adapter.capabilities.publish} />
                    </td>
                    <td className="px-3 py-2.5">
                      <CapabilityBadge mode={adapter.capabilities.nativeSchedule} />
                    </td>
                    <td className="px-3 py-2.5">
                      <CapabilityBadge mode={adapter.capabilities.metrics} />
                    </td>
                    <td className="px-4 py-2.5 text-[10.5px] leading-relaxed text-ink-muted">
                      {adapter.constraints.maxDurationSeconds
                        ? `≤ ${adapter.constraints.maxDurationSeconds}s`
                        : "no duration cap"}
                      {" · "}
                      {adapter.constraints.preferredAspectRatios.join(", ")}
                      {" · "}
                      {adapter.constraints.hashtagMaxCount} hashtags
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-hairline px-4 py-2.5 text-[10.5px] leading-relaxed text-ink-muted">
            Where an official API exists it is the preferred route. YouTube&rsquo;s
            Data API supports upload and scheduled publishing and is the intended
            path for that platform once OAuth credentials exist; Instagram&rsquo;s
            Graph API needs a Business account and an approved Meta app. Neither is
            configured here, so both currently publish through their own web UI in a
            session you authenticated by hand.
          </p>
        </Card>

        {projects.map((project) => (
          <Card key={project.id}>
            <CardHeader
              title={
                <span className="inline-flex items-center gap-2">
                  <ProjectDot color={project.accentColor} />
                  {project.name}
                </span>
              }
              subtitle={`${project.accounts.filter((a) => a.status === AccountStatus.CONNECTED).length} of ${project.accounts.length} connected.`}
            />

            {project.accounts.length === 0 ? (
              <EmptyState
                icon={<Users />}
                title="No accounts on this project"
                body="Add one below. It can be used in simulation mode immediately, and needs a stored session only for live publishing."
              />
            ) : (
              <ul className="divide-y divide-hairline">
                {project.accounts.map((account) => {
                  const adapter = getAdapter(account.platform);
                  return (
                    <li key={account.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <PlatformBadge platform={account.platform} />
                            <span className="text-[12.5px] text-ink">
                              {account.handle}
                            </span>
                            <AccountStatusBadge status={account.status} />
                          </div>
                          <p className="mt-1 text-[10.5px] leading-relaxed text-ink-muted">
                            {account.session
                              ? `Session captured ${relativeTime(account.session.capturedAt)}${
                                  account.session.lastVerifiedAt
                                    ? `, last verified ${relativeTime(account.session.lastVerifiedAt)}`
                                    : ""
                                }`
                              : "No stored session."}
                            {account._count.postPlatforms > 0
                              ? ` · ${account._count.postPlatforms} destinations recorded`
                              : ""}
                          </p>
                          {account.lastError ? (
                            <p className="mt-1 text-[10.5px] leading-relaxed text-[#ec7d7d]">
                              {account.lastError}
                            </p>
                          ) : null}
                          {account.lastCheckedAt ? (
                            <p className="mt-1 text-[10px] tabular text-ink-muted">
                              Checked {dateTimeLabel(account.lastCheckedAt)}
                            </p>
                          ) : null}
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <ActionForm action={connectAccountAction}>
                            <input
                              type="hidden"
                              name="socialAccountId"
                              value={account.id}
                            />
                            <SubmitButton
                              variant="secondary"
                              size="sm"
                              pendingLabel="Queueing…"
                            >
                              <Plug />
                              {account.session ? "Reconnect" : "Connect"}
                            </SubmitButton>
                          </ActionForm>

                          {account.session ? (
                            <>
                              <ActionForm action={verifyAccountAction}>
                                <input
                                  type="hidden"
                                  name="socialAccountId"
                                  value={account.id}
                                />
                                <SubmitButton
                                  variant="ghost"
                                  size="sm"
                                  pendingLabel="Checking…"
                                >
                                  <Link2 />
                                  Test
                                </SubmitButton>
                              </ActionForm>
                              <ActionForm
                                action={disconnectAccountAction}
                                confirm={`Delete the stored session for ${account.handle}? Live publishing will stop until it is reconnected.`}
                              >
                                <input
                                  type="hidden"
                                  name="socialAccountId"
                                  value={account.id}
                                />
                                <SubmitButton
                                  variant="ghost"
                                  size="sm"
                                  pendingLabel="Removing…"
                                >
                                  <Trash2 />
                                  Disconnect
                                </SubmitButton>
                              </ActionForm>
                            </>
                          ) : null}
                        </div>
                      </div>

                      <p className="mt-2 text-[10px] leading-relaxed text-ink-muted">
                        Sign-in opens at{" "}
                        <span className="text-ink-secondary">{adapter.loginUrl}</span>;
                        publishing happens at{" "}
                        <span className="text-ink-secondary">{adapter.composerUrl}</span>.
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="border-t border-hairline px-4 py-3.5">
              <SectionLabel>Add an account</SectionLabel>
              <ActionForm
                action={addAccountAction}
                className="mt-2 flex flex-wrap items-end gap-2"
                resetOnSuccess
              >
                <input type="hidden" name="projectId" value={project.id} />
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-muted">
                    Platform
                  </span>
                  <select
                    name="platform"
                    className="h-8 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink"
                  >
                    {Object.values(Platform).map((platform) => (
                      <option key={platform} value={platform}>
                        {platformLabel(platform)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-muted">
                    Handle
                  </span>
                  <input
                    name="handle"
                    required
                    placeholder="@yourhandle"
                    className="h-8 w-44 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink placeholder:text-ink-muted"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase tracking-wider text-ink-muted">
                    Display name
                  </span>
                  <input
                    name="displayName"
                    placeholder="Optional"
                    className="h-8 w-44 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink placeholder:text-ink-muted"
                  />
                </label>
                <SubmitButton variant="secondary" pendingLabel="Adding…">
                  Add
                </SubmitButton>
              </ActionForm>
            </div>
          </Card>
        ))}

        <Card>
          <CardHeader title="What connecting actually does" />
          <div className="space-y-2 px-4 py-3.5 text-[11.5px] leading-relaxed text-ink-secondary">
            <p>
              Connect queues a job on the worker. The worker opens a real Chromium
              window at the platform&rsquo;s own login page
              {env.playwrightHeadless ? " (currently configured headless, which will not work for a manual sign-in — set PLAYWRIGHT_HEADLESS=0)" : ""}
              . You type your credentials and complete whatever verification the
              platform asks for. This system never fills the login form, never sees
              your password, and never stores one.
            </p>
            <p>
              Once the platform reports a signed-in session, Playwright&rsquo;s{" "}
              <code className="text-ink">storageState</code> — cookies plus
              localStorage — is encrypted with AES-256-GCM using{" "}
              <code className="text-ink">SESSION_ENCRYPTION_KEY</code> and stored.
              Disconnecting deletes it outright.
            </p>
            <p className="text-ink-muted">
              There is no fingerprint spoofing, no stealth plugin and no challenge
              solving anywhere in this system. If a platform presents a verification
              step during a publish, the run fails, keeps a screenshot, and asks a
              person to finish it.
            </p>
          </div>
        </Card>
      </PageBody>
    </>
  );
}
