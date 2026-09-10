"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { KpiCard, MetricRow, PlatformChip } from "@/components/ui/data-display";
import {
  Badge,
  DemoDataBadge,
  EmptyState,
  LinkButton,
  Panel,
  PanelBody,
  PanelHeader,
  Progress,
  Select,
} from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/tabs";
import { PLATFORM_META } from "@/lib/display";
import type { AnalyticsSummary, Client, LearningInsight } from "@/lib/social-scales/contracts";
import { PLATFORMS } from "@/lib/social-scales/contracts";
import { cn, formatCount } from "@/lib/utils";

const PERIODS = [
  { value: "LAST_7_DAYS", label: "Last 7 days" },
  { value: "LAST_30_DAYS", label: "Last 30 days" },
  { value: "LAST_90_DAYS", label: "Last 90 days" },
] as const;

const AXIS = { stroke: "#64748b", fontSize: 11 } as const;

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ value?: number | string; name?: string }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-hairline-strong bg-surface px-3 py-2 text-[12px] shadow-lg">
      <p className="text-ink-faint">{label}</p>
      <p className="mt-0.5 font-semibold text-ink">
        {typeof payload[0].value === "number" ? formatCount(payload[0].value) : payload[0].value}
      </p>
    </div>
  );
}

export function AnalyticsWorkspace({
  summary,
  clients,
  period,
  clientId,
  platform,
}: {
  summary: AnalyticsSummary;
  clients: Client[];
  period: string;
  clientId: string;
  platform: string;
}) {
  const router = useRouter();
  const [seriesKey, setSeriesKey] = React.useState(summary.series[0]?.key ?? "views");

  const navigate = (next: Partial<{ period: string; clientId: string; platform: string }>) => {
    const merged = { period, clientId, platform, ...next };
    const params = new URLSearchParams();
    if (merged.period && merged.period !== "LAST_30_DAYS") params.set("period", merged.period);
    if (merged.clientId) params.set("clientId", merged.clientId);
    if (merged.platform) params.set("platform", merged.platform);
    router.push(`/analytics${params.toString() ? `?${params}` : ""}`);
  };

  const activeSeries = summary.series.find((s) => s.key === seriesKey) ?? summary.series[0];
  const chartData = (activeSeries?.points ?? []).map((p) => ({
    date: p.date.slice(5),
    value: p.value,
  }));
  const useBars = chartData.length <= 14;

  const maxPillarViews = Math.max(1, ...summary.pillarPerformance.map((p) => p.avgViews));

  return (
    <div className="flex flex-col gap-5">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Reporting period"
          value={period}
          onChange={(e) => navigate({ period: e.target.value })}
          className="h-9 w-[160px]"
        >
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Filter by client"
          value={clientId}
          onChange={(e) => navigate({ clientId: e.target.value })}
          className="h-9 w-[180px]"
        >
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Filter by platform"
          value={platform}
          onChange={(e) => navigate({ platform: e.target.value })}
          className="h-9 w-[160px]"
        >
          <option value="">All platforms</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_META[p].label}
            </option>
          ))}
        </Select>

        {summary.isDemoData ? <DemoDataBadge className="ml-auto" /> : null}
      </div>

      {/* Headline KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summary.headline.map((metric) => (
          <KpiCard
            key={metric.key}
            label={metric.label}
            value={metric.value}
            format={metric.format}
            delta={metric.deltaPct}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="flex flex-col gap-5 xl:col-span-8">
          {/* Trend */}
          <Panel>
            <PanelHeader
              eyebrow="Performance"
              title={summary.periodLabel}
              action={
                <Tabs
                  ariaLabel="Metric series"
                  items={summary.series.map((s) => ({ value: s.key, label: s.label }))}
                  value={seriesKey}
                  onChange={setSeriesKey}
                  size="sm"
                />
              }
            />
            <PanelBody>
              <div className="h-[280px] w-full min-w-0 overflow-hidden">
                <ResponsiveContainer width="100%" height="100%">
                  {useBars ? (
                    <BarChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                      <CartesianGrid stroke="#18222f" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} {...AXIS} />
                      <YAxis tickFormatter={(v: number) => formatCount(v)} tickLine={false} axisLine={false} {...AXIS} />
                      <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(34,211,238,0.06)" }} />
                      <Bar dataKey="value" fill="#22d3ee" radius={[3, 3, 0, 0]} maxBarSize={38} isAnimationActive={false} />
                    </BarChart>
                  ) : (
                    <LineChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                      <CartesianGrid stroke="#18222f" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={24} {...AXIS} />
                      <YAxis tickFormatter={(v: number) => formatCount(v)} tickLine={false} axisLine={false} {...AXIS} />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#22d3ee", strokeOpacity: 0.3 }} />
                      <Line type="monotone" dataKey="value" stroke="#22d3ee" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  )}
                </ResponsiveContainer>
              </div>
            </PanelBody>
          </Panel>

          {/* Top content */}
          <Panel>
            <PanelHeader eyebrow="Top performing content" title="What actually worked" />
            <PanelBody>
              {summary.topContent.length === 0 ? (
                <EmptyState
                  title="No published content in this range"
                  description="Once posts go out and platforms report back, they will be ranked here."
                />
              ) : (
                <div className="ss-scrollbar overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left">
                    <thead>
                      <tr className="border-b border-hairline">
                        {["Content", "Platform", "Published", "Views", "Engagement", "Completion"].map((h) => (
                          <th key={h} className="ss-eyebrow pb-2.5 font-semibold">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {summary.topContent.map((row) => (
                        <tr key={row.contentItemId} className="border-b border-hairline last:border-b-0">
                          <td className="max-w-[280px] py-3 pr-3">
                            <span className="line-clamp-1 text-[13px] font-medium text-ink">{row.title}</span>
                          </td>
                          <td className="py-3 pr-3">
                            <PlatformChip platform={row.platform} />
                          </td>
                          <td className="py-3 pr-3 text-[12.5px] whitespace-nowrap text-ink-muted">
                            {new Date(row.publishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                          </td>
                          <td className="py-3 pr-3 text-[13px] text-ink tabular-nums">{formatCount(row.views)}</td>
                          <td className="py-3 pr-3 text-[13px] text-ink tabular-nums">{row.engagementRatePct}%</td>
                          <td className="py-3 text-[13px] text-ink tabular-nums">{row.completionRatePct}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </PanelBody>
          </Panel>

          {/* Pillar performance */}
          <Panel>
            <PanelHeader eyebrow="Content pillar performance" title="Which angles carry the account" />
            <PanelBody>
              <ul className="flex flex-col gap-3.5">
                {summary.pillarPerformance.map((pillar) => (
                  <li key={pillar.pillarId}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-[13px] font-medium text-ink">{pillar.pillarName}</span>
                      <span className="text-[12px] text-ink-muted">
                        {pillar.posts} posts · {formatCount(pillar.avgViews)} avg views · {pillar.engagementRatePct}%
                        engagement
                      </span>
                    </div>
                    <Progress value={(pillar.avgViews / maxPillarViews) * 100} className="mt-2" />
                  </li>
                ))}
              </ul>
            </PanelBody>
          </Panel>
        </div>

        <div className="flex flex-col gap-5 xl:col-span-4">
          {/* Secondary metrics */}
          <Panel>
            <PanelHeader eyebrow="All measurements" title={summary.periodLabel} />
            <PanelBody>
              <div className="flex flex-col">
                {summary.secondary.map((metric) => (
                  <MetricRow
                    key={metric.key}
                    label={metric.label}
                    value={metric.value}
                    format={metric.format}
                    delta={metric.deltaPct}
                  />
                ))}
              </div>
            </PanelBody>
          </Panel>

          {/* Best posting times */}
          <Panel>
            <PanelHeader eyebrow="Best posting times" title="When the audience is live" />
            <PanelBody>
              <div className="flex items-end justify-between gap-1.5">
                {summary.bestPostingTimes.map((slot) => (
                  <div key={slot.day} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                    <div className="flex h-24 w-full items-end justify-center">
                      <div
                        className={cn("w-full rounded-t", slot.isPeak ? "bg-accent" : "bg-accent/30")}
                        style={{ height: `${slot.strengthPct}%` }}
                        title={`${slot.day} ${slot.time} — ${slot.strengthPct}% of peak`}
                      />
                    </div>
                    <span className={cn("text-[10.5px]", slot.isPeak ? "font-semibold text-accent" : "text-ink-faint")}>
                      {slot.day}
                    </span>
                    <span className="text-[9.5px] text-ink-faint">{slot.time}</span>
                  </div>
                ))}
              </div>
            </PanelBody>
          </Panel>

          <LinkButton href="/plan" variant="secondary" className="w-full">
            Apply learnings to the next plan
          </LinkButton>
        </div>
      </div>
    </div>
  );
}

export function InsightsPanel({ insights }: { insights: LearningInsight[] }) {
  return (
    <Panel>
      <PanelHeader
        eyebrow="What the system learned"
        title="Observations from this dataset"
        description="Each observation is derived from measured performance, not from guesswork."
      />
      <PanelBody>
        <ul className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
          {insights.map((insight) => (
            <li key={insight.id} className="rounded-[var(--radius-card)] border border-hairline bg-surface-2/55 p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[13.5px] font-medium text-ink">{insight.headline}</p>
                <Badge
                  className={cn(
                    insight.confidence === "STRONG"
                      ? "border-ok/25 bg-ok/10 text-ok"
                      : insight.confidence === "EMERGING"
                        ? "border-accent/25 bg-accent/10 text-accent"
                        : "border-hairline bg-white/6 text-ink-muted",
                  )}
                >
                  {insight.confidence.toLowerCase()}
                </Badge>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">{insight.detail}</p>
              {insight.appliesToNextPlan ? (
                <Badge className="mt-2.5 border-accent/25 bg-accent/10 text-accent">Applied to next plan</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      </PanelBody>
    </Panel>
  );
}
