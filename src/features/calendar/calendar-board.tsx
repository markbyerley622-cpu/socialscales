"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Plus } from "lucide-react";

import { Drawer } from "@/components/ui/drawer";
import { PlatformChip, StatusBadge, Thumb } from "@/components/ui/data-display";
import {
  Button,
  EmptyState,
  LinkButton,
  Panel,
  PanelBody,
  PanelHeader,
  Select,
} from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/tabs";
import { PLATFORM_META } from "@/lib/display";
import type { CalendarSlotPost, CalendarView, Client } from "@/lib/social-scales/contracts";
import { PLATFORMS } from "@/lib/social-scales/contracts";
import { cn } from "@/lib/utils";

const toLocalDate = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export function CalendarBoard({
  view,
  clients,
  mode,
  start,
  clientId,
  platform,
}: {
  view: CalendarView;
  clients: Client[];
  mode: "WEEK" | "MONTH";
  start: string;
  clientId: string;
  platform: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<CalendarSlotPost | null>(null);

  const navigate = (next: Partial<{ mode: string; start: string; clientId: string; platform: string }>) => {
    const params = new URLSearchParams();
    const merged = { mode, start, clientId, platform, ...next };
    if (merged.mode !== "WEEK") params.set("mode", merged.mode);
    if (merged.start) params.set("start", merged.start);
    if (merged.clientId) params.set("clientId", merged.clientId);
    if (merged.platform) params.set("platform", merged.platform);
    router.push(`/calendar${params.toString() ? `?${params}` : ""}`);
  };

  // Shift from the range the adapter actually resolved, not from the raw query
  // param: on first load `start` is empty and `new Date("")` is an Invalid Date.
  //
  // The date is serialised in LOCAL terms. `toISOString()` would convert to UTC
  // and, anywhere east of Greenwich, hand the server the previous day.
  const shift = (days: number) => {
    const date = new Date(view.rangeStart);
    if (Number.isNaN(date.getTime())) return;
    date.setDate(date.getDate() + days);
    navigate({ start: toLocalDate(date) });
  };

  const step = mode === "WEEK" ? 7 : 35;
  const weekDays = view.days.slice(0, 7);

  return (
    <>
      <Panel>
        <PanelHeader
          eyebrow="Content calendar"
          title={view.rangeLabel}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Tabs
                ariaLabel="Calendar view mode"
                items={[
                  { value: "WEEK", label: "Week" },
                  { value: "MONTH", label: "Month" },
                ]}
                value={mode}
                onChange={(value) => navigate({ mode: value })}
                size="sm"
              />
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => shift(-step)} aria-label="Previous period">
                  <ChevronLeft className="size-4" />
                </Button>
                <Button size="sm" variant="secondary" onClick={() => navigate({ start: "" })}>
                  Today
                </Button>
                <Button size="sm" variant="ghost" onClick={() => shift(step)} aria-label="Next period">
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>
          }
        />

        <PanelBody className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Filter by client"
              value={clientId}
              onChange={(e) => navigate({ clientId: e.target.value })}
              className="h-8 w-[180px] text-[12px]"
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
              className="h-8 w-[160px] text-[12px]"
            >
              <option value="">All platforms</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_META[p].label}
                </option>
              ))}
            </Select>

            <LinkButton href="/studio" size="sm" variant="primary" className="ml-auto">
              <Plus className="size-3.5" />
              Schedule a post
            </LinkButton>
          </div>
        </PanelBody>

        <PanelBody>
          {mode === "WEEK" ? (
            <div className="ss-scrollbar overflow-x-auto">
              <div className="min-w-[880px]">
                {/* Day headers */}
                <div className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))] gap-1.5">
                  <div />
                  {weekDays.map((day) => (
                    <div
                      key={day.date}
                      className={cn(
                        "rounded-t-md px-2 py-2 text-center",
                        day.isToday ? "bg-accent/10 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.25)]" : "",
                      )}
                    >
                      <p className={cn("text-[11px] font-semibold tracking-wider", day.isToday ? "text-accent" : "text-ink")}>
                        {day.dayLabel}
                      </p>
                      <p className="text-[11px] text-ink-faint">{day.date}</p>
                    </div>
                  ))}
                </div>

                {/* Hour rows */}
                {view.hourRows.map((hour) => (
                  <div key={hour} className="grid grid-cols-[64px_repeat(7,minmax(0,1fr))] gap-1.5 border-t border-hairline">
                    <div className="py-3 pr-2 text-right text-[11px] text-ink-faint">{hour}</div>
                    {weekDays.map((day) => {
                      const posts = day.posts.filter((p) => p.hourLabel === hour);
                      return (
                        <div key={`${day.date}-${hour}`} className={cn("py-1.5", day.isToday && "bg-accent/[0.04]")}>
                          {posts.length === 0 ? (
                            <div className="flex h-[52px] items-center justify-center rounded-md border border-dashed border-hairline text-ink-faint/50">
                              <Plus className="size-3.5" />
                            </div>
                          ) : (
                            <div className="flex flex-col gap-1.5">
                              {posts.map((post) => (
                                <button
                                  key={post.id}
                                  type="button"
                                  onClick={() => setSelected(post)}
                                  className="w-full rounded-md border border-hairline bg-surface-2/70 p-1.5 text-left transition-colors hover:border-accent/35"
                                >
                                  <Thumb tone={post.thumbnailTone} platform={post.platform} className="h-9 w-full" />
                                  <p className="mt-1 line-clamp-1 text-[10.5px] font-medium text-ink">{post.title}</p>
                                  <p className="text-[9.5px] text-ink-faint">
                                    {new Date(post.scheduledFor).toLocaleTimeString("en-GB", {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </p>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="ss-scrollbar overflow-x-auto">
              <div className="grid min-w-[760px] grid-cols-7 gap-1.5">
                {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((label) => (
                  <p key={label} className="pb-1 text-center text-[11px] font-semibold tracking-wider text-ink-muted">
                    {label}
                  </p>
                ))}
                {view.days.map((day) => (
                  <div
                    key={day.date}
                    className={cn(
                      "min-h-[104px] rounded-md border p-2",
                      day.isToday
                        ? "border-accent/35 bg-accent/8"
                        : "border-hairline bg-surface-2/40",
                    )}
                  >
                    <p className={cn("text-[11px]", day.isToday ? "font-semibold text-accent" : "text-ink-faint")}>
                      {day.date}
                    </p>
                    <div className="mt-1.5 flex flex-col gap-1">
                      {day.posts.slice(0, 3).map((post) => (
                        <button
                          key={post.id}
                          type="button"
                          onClick={() => setSelected(post)}
                          className="flex items-center gap-1.5 rounded border border-hairline bg-surface-3/60 px-1.5 py-1 text-left hover:border-accent/35"
                        >
                          <PlatformChip platform={post.platform} />
                          <span className="line-clamp-1 text-[10px] text-ink">{post.title}</span>
                        </button>
                      ))}
                      {day.posts.length > 3 ? (
                        <span className="text-[10px] text-ink-faint">+{day.posts.length - 3} more</span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </PanelBody>
      </Panel>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Panel className="xl:col-span-2">
          <PanelHeader
            eyebrow="Scheduled queue"
            title={`${view.scheduledQueue.length} posts scheduled`}
            action={<LinkButton href="/content?status=SCHEDULED" size="sm" variant="ghost">View all</LinkButton>}
          />
          <PanelBody>
            {view.scheduledQueue.length === 0 ? (
              <EmptyState
                icon={<CalendarDays className="size-6" />}
                title="Nothing scheduled in this range"
                description="Approve content in the Studio and give it a publish slot."
                action={<LinkButton href="/studio" size="sm" variant="secondary">Open Studio</LinkButton>}
              />
            ) : (
              <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                {view.scheduledQueue.map((post) => (
                  <li key={post.id}>
                    <button
                      type="button"
                      onClick={() => setSelected({ ...post, hourLabel: "" })}
                      className="w-full rounded-[var(--radius-card)] border border-hairline bg-surface-2/55 p-2.5 text-left transition-colors hover:border-accent/30"
                    >
                      <Thumb tone={post.thumbnailTone} platform={post.platform} className="h-24 w-full" />
                      <p className="mt-2 line-clamp-2 text-[12.5px] font-medium text-ink">{post.title}</p>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-[11px] text-ink-faint">
                          {new Date(post.scheduledFor).toLocaleString("en-GB", {
                            weekday: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <StatusBadge status={post.status} />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader eyebrow="Best posting times" title="Based on audience activity" />
          <PanelBody>
            <div className="flex items-end justify-between gap-1.5">
              {view.bestPostingTimes.map((slot) => (
                <div key={slot.day} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                  <div className="flex h-24 w-full items-end justify-center">
                    <div
                      className={cn(
                        "w-full rounded-t",
                        slot.isPeak ? "bg-accent" : "bg-accent/30",
                      )}
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
            <p className="mt-4 flex items-start gap-2 border-t border-hairline pt-3 text-[11.5px] leading-snug text-ink-muted">
              <Clock className="mt-0.5 size-3.5 shrink-0 text-accent" />
              Peak slot in this dataset is {view.bestPostingTimes.find((s) => s.isPeak)?.day}{" "}
              {view.bestPostingTimes.find((s) => s.isPeak)?.time}.
            </p>
          </PanelBody>
        </Panel>
      </div>

      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.title ?? ""}
        subtitle={
          selected ? (
            <span className="flex items-center gap-2">
              <PlatformChip platform={selected.platform} showLabel />
              <span>{selected.clientName}</span>
            </span>
          ) : null
        }
        footer={
          selected ? (
            <LinkButton href={`/studio?contentItemId=${selected.contentItemId}`} variant="primary" size="sm" className="w-full">
              Open in Studio
            </LinkButton>
          ) : null
        }
      >
        {selected ? (
          <div className="flex flex-col gap-4">
            <Thumb tone={selected.thumbnailTone} platform={selected.platform} className="aspect-[9/16] w-full max-w-[220px]" />
            <dl className="flex flex-col">
              {[
                ["Status", <StatusBadge key="s" status={selected.status} />],
                [
                  "Scheduled for",
                  new Date(selected.scheduledFor).toLocaleString("en-GB", {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                ],
                ["Client", selected.clientName],
                ["Platform", PLATFORM_META[selected.platform].label],
              ].map(([label, value]) => (
                <div key={label as string} className="flex items-center justify-between gap-3 border-b border-hairline py-2.5 last:border-b-0">
                  <dt className="text-[12px] text-ink-muted">{label}</dt>
                  <dd className="text-right text-[12.5px] text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
