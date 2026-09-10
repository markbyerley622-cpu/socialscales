import type { Metadata } from "next";

import { PageHero } from "@/components/shell/page-hero";
import { AnalyticsWorkspace, InsightsPanel } from "@/features/analytics/analytics-workspace";
import { getAdapter } from "@/lib/social-scales";
import type { AnalyticsPeriod } from "@/lib/social-scales/adapter";
import { PLATFORMS, type Platform } from "@/lib/social-scales/contracts";

export const metadata: Metadata = { title: "Analytics" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

const PERIODS: AnalyticsPeriod[] = ["LAST_7_DAYS", "LAST_30_DAYS", "LAST_90_DAYS"];

export default async function AnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;

  const rawPeriod = first(params.period);
  const period: AnalyticsPeriod = (PERIODS as string[]).includes(rawPeriod)
    ? (rawPeriod as AnalyticsPeriod)
    : "LAST_30_DAYS";

  const rawPlatform = first(params.platform);
  const platform = (PLATFORMS as readonly string[]).includes(rawPlatform) ? (rawPlatform as Platform) : null;
  const clientId = first(params.clientId) || null;

  const adapter = getAdapter();
  const [summary, clients, insights] = await Promise.all([
    adapter.getAnalytics(period, { clientId, platform }),
    adapter.getClients(),
    adapter.getInsights(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="Performance &"
        accentWord="Learning"
        subtitle="What went out, what it did, and what the system changes because of it."
        kicker={["Measure", "Learn", "Adjust"]}
      />

      <AnalyticsWorkspace
        summary={summary}
        clients={clients}
        period={period}
        clientId={clientId ?? ""}
        platform={platform ?? ""}
      />

      <InsightsPanel insights={insights} />
    </div>
  );
}
