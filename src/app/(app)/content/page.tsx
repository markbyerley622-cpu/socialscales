import type { Metadata } from "next";

import { PageHero } from "@/components/shell/page-hero";
import { ContentQueue } from "@/features/content/content-queue";
import { getAdapter } from "@/lib/social-scales";
import { CONTENT_STATUSES, PLATFORMS, type ContentStatus, type Platform } from "@/lib/social-scales/contracts";

export const metadata: Metadata = { title: "Content" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

export default async function ContentPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;

  const rawStatus = first(params.status);
  const rawPlatform = first(params.platform);

  const status = (CONTENT_STATUSES as readonly string[]).includes(rawStatus) ? (rawStatus as ContentStatus) : null;
  const platform = (PLATFORMS as readonly string[]).includes(rawPlatform) ? (rawPlatform as Platform) : null;
  const clientId = first(params.clientId) || null;
  const search = first(params.search) || null;

  const adapter = getAdapter();
  const [queue, clients, plan] = await Promise.all([
    adapter.getContentQueue({ status, clientId, platform, search }),
    adapter.getClients(),
    adapter.getActivePlan(),
  ]);

  const pillarNames = Object.fromEntries((plan?.pillars ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="Content"
        accentWord="pipeline"
        subtitle="One queue, one lifecycle. Ideas become briefs, briefs become scripts, scripts become scheduled posts."
        kicker={["Ideas", "Briefs", "Scripts", "Assets", "Ready"]}
      />

      <ContentQueue
        items={queue.items}
        counts={queue.counts}
        clients={clients}
        pillarNames={pillarNames}
        filters={{
          status: status ?? "",
          clientId: clientId ?? "",
          platform: platform ?? "",
          search: search ?? "",
        }}
      />
    </div>
  );
}
