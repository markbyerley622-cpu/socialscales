import type { Metadata } from "next";

import { PageHero } from "@/components/shell/page-hero";
import { CalendarBoard } from "@/features/calendar/calendar-board";
import { getAdapter } from "@/lib/social-scales";
import { PLATFORMS, type Platform } from "@/lib/social-scales/contracts";

export const metadata: Metadata = { title: "Calendar" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;

  const mode = first(params.mode) === "MONTH" ? "MONTH" : "WEEK";
  const rawPlatform = first(params.platform);
  const platform = (PLATFORMS as readonly string[]).includes(rawPlatform) ? (rawPlatform as Platform) : null;
  const clientId = first(params.clientId) || null;

  // An empty `start` means "whatever the data source considers now" — the mock
  // adapter anchors to its fixture week, a real backend to the actual date.
  const requestedStart = first(params.start);

  const adapter = getAdapter();
  const [view, clients] = await Promise.all([
    adapter.getCalendar({ start: requestedStart || undefined, mode, clientId, platform }),
    adapter.getClients(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="Content &"
        accentWord="Scheduler"
        subtitle="Plan the week, see every slot, and know exactly what goes out when."
        kicker={["Plan", "Post", "Grow"]}
      />

      <CalendarBoard
        view={view}
        clients={clients}
        mode={mode}
        start={requestedStart}
        clientId={clientId ?? ""}
        platform={platform ?? ""}
      />
    </div>
  );
}
