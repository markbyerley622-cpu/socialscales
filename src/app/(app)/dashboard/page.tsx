import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  FileText,
  Lightbulb,
  Sparkles,
  UserPlus,
} from "lucide-react";

import { PipelinePanel } from "@/features/dashboard/pipeline";
import { PageHero } from "@/components/shell/page-hero";
import {
  KpiCard,
  Sparkline,
  StatusBadge,
  Thumb,
} from "@/components/ui/data-display";
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
import { cn, relativeFrom } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };

const ACTIVITY_ICONS = {
  IDEA: Lightbulb,
  SCRIPT: FileText,
  SCHEDULE: CalendarDays,
  REPORT: BarChart3,
  CLIENT: UserPlus,
  OPTIMISATION: Sparkles,
  PUBLISH: ArrowUpRight,
} as const;

export default async function DashboardPage() {
  const view = await getAdapter().getDashboard();
  const now = new Date();

  const attention = [
    ...view.approvals.slice(0, 3).map((a) => ({
      id: a.id,
      label: `Review "${a.title}"`,
      detail: `${a.clientName} · waiting ${a.waitingSinceHours}h · ${a.reason}`,
      href: `/studio?contentItemId=${a.contentItemId}`,
      cta: "Open in Studio",
    })),
    ...(view.plan?.status === "AWAITING_APPROVAL"
      ? [
          {
            id: "plan-approval",
            label: "Approve this week's plan",
            detail: `${view.plan.label} is generated but not yet approved.`,
            href: "/plan",
            cta: "Review plan",
          },
        ]
      : []),
    ...(view.queue.failed > 0
      ? [
          {
            id: "failed",
            label: `${view.queue.failed} generation${view.queue.failed === 1 ? "" : "s"} failed`,
            detail: "The render did not complete. Check the failure reason and retry.",
            href: "/content?status=FAILED",
            cta: "Inspect",
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="Welcome to"
        accentWord="Social Scales"
        subtitle="Your AI-powered SMMA partner. Strategy in, scheduled content out, performance read back into next week."
        kicker={["Strategy", "Content", "Automation", "Real results"]}
        actions={
          <>
            <LinkButton href="/studio" variant="primary">Open Content Studio</LinkButton>
            <LinkButton href="/plan" variant="secondary">View this week&rsquo;s plan</LinkButton>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* ------------------------------- Left ------------------------------- */}
        <div className="flex flex-col gap-5 xl:col-span-8">
          <PipelinePanel stages={view.pipeline} />

          {/* Needs your attention */}
          <Panel>
            <PanelHeader
              eyebrow="Needs your attention"
              title={attention.length > 0 ? `${attention.length} things are blocked on you` : "Nothing is blocked on you"}
              action={
                <LinkButton href="/content?status=NEEDS_REVIEW" size="sm" variant="ghost">View queue</LinkButton>
              }
            />
            <PanelBody>
              {attention.length === 0 ? (
                <EmptyState
                  icon={<CheckCircle2 className="size-6" />}
                  title="The queue is clear"
                  description="Nothing is waiting on approval and the plan is active. The system will keep producing against it."
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {attention.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-hairline bg-surface-2/60 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] font-medium text-ink">{item.label}</p>
                        <p className="mt-0.5 truncate text-[12px] text-ink-muted">{item.detail}</p>
                      </div>
                      <LinkButton href={item.href} size="sm" variant="secondary">
                        {item.cta}
                      </LinkButton>
                    </li>
                  ))}
                </ul>
              )}
            </PanelBody>
          </Panel>

          {/* Week at a glance */}
          <Panel>
            <PanelHeader
              eyebrow="This week"
              title={view.plan?.periodLabel ?? "Content calendar"}
              action={
                <LinkButton href="/calendar" size="sm" variant="secondary">Open calendar</LinkButton>
              }
            />
            <PanelBody>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                {view.weekAtAGlance.map((day) => (
                  <div
                    key={day.date}
                    className="rounded-[var(--radius-card)] border border-hairline bg-surface-2/50 p-2.5"
                  >
                    <p className="text-[11px] font-semibold tracking-wider text-ink">{day.dayLabel}</p>
                    <p className="text-[11px] text-ink-faint">{day.date}</p>
                    <div className="mt-2 flex flex-col gap-1.5">
                      {day.posts.slice(0, 3).map((post) => (
                        <Thumb
                          key={post.id}
                          tone={post.thumbnailTone}
                          platform={post.platform}
                          className="h-11 w-full"
                        />
                      ))}
                      {day.posts.length === 0 ? (
                        <div className="flex h-11 items-center justify-center rounded-md border border-dashed border-hairline text-[11px] text-ink-faint">
                          —
                        </div>
                      ) : null}
                      {day.posts.length > 3 ? (
                        <p className="text-center text-[10.5px] text-ink-faint">+{day.posts.length - 3} more</p>
                      ) : null}
                    </div>
                    <p className="mt-2 text-[11px] text-ink-muted">
                      {day.posts.length} post{day.posts.length === 1 ? "" : "s"}
                    </p>
                  </div>
                ))}
              </div>
            </PanelBody>
          </Panel>

          {/* Upcoming posts */}
          <Panel>
            <PanelHeader
              eyebrow="Publishing next"
              title="Approved and scheduled"
              description="Everything here will go out without further input from you."
              action={
                <LinkButton href="/content?status=SCHEDULED" size="sm" variant="ghost">Manage queue</LinkButton>
              }
            />
            <PanelBody>
              {view.upcomingPosts.length === 0 ? (
                <EmptyState
                  icon={<CalendarDays className="size-6" />}
                  title="Nothing scheduled yet"
                  description="Approve content in the Studio and it will appear here with its publish slot."
                  action={
                    <LinkButton href="/studio" variant="secondary" size="sm">
                      Open Studio
                    </LinkButton>
                  }
                />
              ) : (
                <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {view.upcomingPosts.map((post) => (
                    <li
                      key={post.id}
                      className="flex items-center gap-3 rounded-[var(--radius-card)] border border-hairline bg-surface-2/55 p-2.5"
                    >
                      <Thumb tone={post.thumbnailTone} platform={post.platform} className="size-14 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-ink">{post.title}</p>
                        <p className="mt-0.5 truncate text-[11.5px] text-ink-muted">{post.clientName}</p>
                        <div className="mt-1.5 flex items-center gap-2">
                          <StatusBadge status={post.status} />
                          <span className="text-[11px] text-ink-faint">
                            {new Date(post.scheduledFor).toLocaleString("en-GB", {
                              weekday: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </PanelBody>
          </Panel>

          {/* Insights */}
          <Panel>
            <PanelHeader
              eyebrow="What the system learned"
              title="Feeding the next plan"
              action={
                <LinkButton href="/analytics" size="sm" variant="ghost">View all</LinkButton>
              }
            />
            <PanelBody>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {view.insights.map((insight) => (
                  <li
                    key={insight.id}
                    className="rounded-[var(--radius-card)] border border-hairline bg-surface-2/55 px-3.5 py-3"
                  >
                    <p className="text-[13px] font-medium text-ink">{insight.headline}</p>
                    <p className="mt-1 text-[12px] leading-snug text-ink-muted">{insight.detail}</p>
                    {insight.appliesToNextPlan ? (
                      <Badge className="mt-2 border-accent/25 bg-accent/10 text-accent">Applied to next plan</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            </PanelBody>
          </Panel>
        </div>

        {/* ------------------------------- Right ------------------------------ */}
        <div className="flex flex-col gap-5 xl:col-span-4">
          {/* Active plan */}
          <Panel>
            <PanelHeader eyebrow="Active plan" title={view.plan?.label ?? "No plan yet"} />
            <PanelBody>
              {view.plan ? (
                <>
                  <p className="text-[13px] leading-relaxed text-ink-muted">{view.plan.objective}</p>
                  <div className="mt-4 flex items-center justify-between text-[12px]">
                    <span className="text-ink-muted">Plan adherence</span>
                    <span className="font-semibold text-ink tabular-nums">{view.plan.adherencePct}%</span>
                  </div>
                  <Progress value={view.plan.adherencePct} className="mt-2" />
                  <div className="mt-4 flex items-center justify-between">
                    <Badge
                      className={cn(
                        view.plan.status === "ACTIVE"
                          ? "border-ok/25 bg-ok/10 text-ok"
                          : "border-warn/28 bg-warn/10 text-warn",
                      )}
                      dot={view.plan.status === "ACTIVE" ? "bg-ok" : "bg-warn"}
                    >
                      {view.plan.status === "ACTIVE" ? "Active" : "Awaiting approval"}
                    </Badge>
                    <LinkButton href="/plan" size="sm" variant="ghost">Open plan</LinkButton>
                  </div>
                </>
              ) : (
                <EmptyState title="No active plan" description="Run onboarding to generate the first content plan." />
              )}
            </PanelBody>
          </Panel>

          {/* Performance overview */}
          <Panel>
            <PanelHeader
              eyebrow="Performance overview"
              title="Last 30 days"
              action={<DemoDataBadge />}
            />
            <PanelBody>
              <div className="grid grid-cols-2 gap-2.5">
                {view.metrics.map((metric) => (
                  <KpiCard
                    key={metric.key}
                    label={metric.label}
                    value={metric.value}
                    format={metric.format}
                    delta={metric.deltaPct}
                  />
                ))}
              </div>
              <div className="mt-4 rounded-[var(--radius-card)] border border-hairline bg-surface-2/50 p-3">
                <p className="ss-eyebrow">{view.performanceSeries.label}</p>
                <Sparkline points={view.performanceSeries.points.map((p) => p.value)} height={56} className="mt-2" />
                <div className="mt-1 flex justify-between text-[10.5px] text-ink-faint">
                  <span>{view.performanceSeries.points.at(0)?.date}</span>
                  <span>{view.performanceSeries.points.at(-1)?.date}</span>
                </div>
              </div>
            </PanelBody>
          </Panel>

          {/* Recent activity */}
          <Panel>
            <PanelHeader eyebrow="Recent activity" title="What the system did" />
            <PanelBody>
              <ul className="flex flex-col">
                {view.recentActivity.map((event) => {
                  const Icon = ACTIVITY_ICONS[event.kind];
                  return (
                    <li key={event.id} className="flex items-start gap-3 border-b border-hairline py-2.5 last:border-b-0">
                      <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline bg-surface-3 text-accent">
                        <Icon className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-muted">{event.message}</span>
                      <span className="shrink-0 text-[11px] whitespace-nowrap text-ink-faint">
                        {relativeFrom(event.occurredAt, now)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </PanelBody>
          </Panel>

          {/* Clients */}
          <Panel>
            <PanelHeader
              eyebrow="Client overview"
              title={`${view.clients.filter((c) => c.status === "ACTIVE").length} active`}
              action={
                <LinkButton href="/clients" size="sm" variant="ghost">View all</LinkButton>
              }
            />
            <PanelBody>
              <ul className="flex flex-col">
                {view.clients.slice(0, 5).map((client) => (
                  <li key={client.id} className="border-b border-hairline py-2.5 last:border-b-0">
                    <Link href="/clients" className="flex items-center gap-3">
                      <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-accent/22 bg-accent/8 text-[11px] font-semibold text-accent">
                        {client.initials}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-ink">{client.name}</span>
                        <span className="block truncate text-[11px] text-ink-faint">
                          {client.postsThisWeek} posts this week
                          {client.engagementTrendPct !== null ? ` · ${client.engagementTrendPct > 0 ? "+" : ""}${client.engagementTrendPct}% engagement` : ""}
                        </span>
                      </span>
                      <Badge
                        className={cn(
                          client.status === "ACTIVE"
                            ? "border-ok/25 bg-ok/10 text-ok"
                            : client.status === "ONBOARDING"
                              ? "border-accent/25 bg-accent/10 text-accent"
                              : "border-hairline bg-white/6 text-ink-muted",
                        )}
                        dot={client.status === "ACTIVE" ? "bg-ok" : undefined}
                      >
                        {client.status === "ACTIVE"
                          ? "Active"
                          : client.status === "ONBOARDING"
                            ? "Onboarding"
                            : client.status === "PAUSED"
                              ? "Paused"
                              : "Archived"}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </div>
  );
}
