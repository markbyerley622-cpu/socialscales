import type { Metadata } from "next";
import { AlertTriangle, CheckCircle2, Users } from "lucide-react";

import { PageHero } from "@/components/shell/page-hero";
import { PlatformChip } from "@/components/ui/data-display";
import {
  Badge,
  DemoDataBadge,
  EmptyState,
  LinkButton,
  Panel,
  PanelBody,
  PanelHeader,
  Progress,
} from "@/components/ui/primitives";
import { getAdapter } from "@/lib/social-scales";
import type { Client } from "@/lib/social-scales/contracts";
import { cn, relativeFrom } from "@/lib/utils";

export const metadata: Metadata = { title: "Clients" };

const STATUS_STYLES: Record<Client["status"], string> = {
  ACTIVE: "border-ok/25 bg-ok/10 text-ok",
  ONBOARDING: "border-accent/25 bg-accent/10 text-accent",
  PAUSED: "border-warn/25 bg-warn/10 text-warn",
  ARCHIVED: "border-hairline bg-white/6 text-ink-muted",
};

const HEALTH_STYLES: Record<Client["health"], { label: string; className: string }> = {
  HEALTHY: { label: "Healthy", className: "text-ok" },
  ATTENTION: { label: "Needs attention", className: "text-warn" },
  AT_RISK: { label: "At risk", className: "text-danger" },
};

const PLAN_LABEL: Record<Client["planStatus"], string> = {
  DRAFT: "Plan not generated",
  AWAITING_APPROVAL: "Plan awaiting approval",
  ACTIVE: "Plan active",
  COMPLETED: "Plan completed",
};

export default async function ClientsPage() {
  const clients = await getAdapter().getClients();
  const now = new Date();

  const active = clients.filter((c) => c.status === "ACTIVE");
  const onboarding = clients.filter((c) => c.status === "ONBOARDING");
  const needsAttention = clients.filter((c) => c.health !== "HEALTHY");
  const totalApprovals = clients.reduce((sum, c) => sum + c.awaitingApproval, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="Client"
        accentWord="workspaces"
        subtitle="Every brand running on the system, with its plan state and what is waiting on you."
        kicker={["Onboard", "Plan", "Produce", "Report"]}
        actions={<LinkButton href="/onboarding" variant="primary">Onboard a new client</LinkButton>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Active clients", value: active.length, icon: <Users className="size-4" /> },
          { label: "In onboarding", value: onboarding.length, icon: <Users className="size-4" /> },
          { label: "Awaiting approval", value: totalApprovals, icon: <AlertTriangle className="size-4" /> },
          { label: "Healthy", value: clients.length - needsAttention.length, icon: <CheckCircle2 className="size-4" /> },
        ].map((stat) => (
          <div key={stat.label} className="rounded-[var(--radius-card)] border border-hairline bg-surface-2/60 p-4">
            <span className="inline-flex size-8 items-center justify-center rounded-lg border border-accent/20 bg-accent/8 text-accent">
              {stat.icon}
            </span>
            <p className="mt-2.5 text-[22px] leading-none font-semibold text-ink tabular-nums">{stat.value}</p>
            <p className="mt-1 text-[12px] text-ink-muted">{stat.label}</p>
          </div>
        ))}
      </div>

      <Panel>
        <PanelHeader
          eyebrow="All clients"
          title={`${clients.length} workspaces`}
          action={<DemoDataBadge />}
        />
        <PanelBody>
          {clients.length === 0 ? (
            <EmptyState
              icon={<Users className="size-6" />}
              title="No clients yet"
              description="Run onboarding to add the first brand and generate its content system."
              action={<LinkButton href="/onboarding" size="sm" variant="primary">Start onboarding</LinkButton>}
            />
          ) : (
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {clients.map((client) => {
                const health = HEALTH_STYLES[client.health];
                return (
                  <li
                    key={client.id}
                    className="flex flex-col rounded-[var(--radius-card)] border border-hairline bg-surface-2/55 p-4"
                  >
                    <div className="flex items-start gap-3">
                      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-accent/22 bg-accent/8 text-[13px] font-semibold text-accent">
                        {client.initials}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] font-semibold text-ink">{client.name}</p>
                        <p className="truncate text-[12px] text-ink-muted">{client.niche}</p>
                      </div>
                      <Badge className={STATUS_STYLES[client.status]}>
                        {client.status.charAt(0) + client.status.slice(1).toLowerCase()}
                      </Badge>
                    </div>

                    <div className="mt-3.5 flex items-center gap-1.5">
                      {client.connectedPlatforms.length > 0 ? (
                        client.connectedPlatforms.map((p) => <PlatformChip key={p} platform={p} />)
                      ) : (
                        <span className="text-[11.5px] text-ink-faint">No platforms connected</span>
                      )}
                    </div>

                    <dl className="mt-3.5 grid grid-cols-3 gap-2 border-y border-hairline py-3">
                      {[
                        ["Posts / week", client.postsThisWeek],
                        ["Awaiting review", client.awaitingApproval],
                        ["Upcoming", client.upcomingPosts],
                      ].map(([label, value]) => (
                        <div key={label as string}>
                          <dt className="text-[10.5px] tracking-wide text-ink-faint uppercase">{label}</dt>
                          <dd className="mt-0.5 text-[15px] font-semibold text-ink tabular-nums">{value}</dd>
                        </div>
                      ))}
                    </dl>

                    <div className="mt-3 flex items-center justify-between text-[12px]">
                      <span className="text-ink-muted">{PLAN_LABEL[client.planStatus]}</span>
                      <span className={cn("font-medium", health.className)}>{health.label}</span>
                    </div>

                    {client.onboardingComplete ? null : (
                      <div className="mt-2.5">
                        <p className="mb-1.5 text-[11.5px] text-ink-faint">Onboarding in progress</p>
                        <Progress value={40} />
                      </div>
                    )}

                    <div className="mt-4 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-ink-faint">
                        Updated {relativeFrom(client.lastActivityAt, now)}
                      </span>
                      <div className="flex gap-1.5">
                        <LinkButton href="/plan" size="sm" variant="ghost">
                          Plan
                        </LinkButton>
                        <LinkButton href={`/content?clientId=${client.id}`} size="sm" variant="secondary">
                          Content
                        </LinkButton>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}
