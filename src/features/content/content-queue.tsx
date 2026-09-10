"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CheckCheck, Inbox, Loader2, Search } from "lucide-react";

import { approveContentAction } from "@/app/actions";
import { Drawer } from "@/components/ui/drawer";
import { GenerationBadge, PlatformChip, StatusBadge, Thumb } from "@/components/ui/data-display";
import {
  Button,
  EmptyState,
  Input,
  LinkButton,
  Panel,
  PanelBody,
  PanelHeader,
  Progress,
  Select,
} from "@/components/ui/primitives";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { CONTENT_STATUS_META, GENERATION_STATUS_META, PLATFORM_META } from "@/lib/display";
import type {
  Client,
  ContentItem,
  ContentStatus,
  QueueCounts,
} from "@/lib/social-scales/contracts";
import { PLATFORMS } from "@/lib/social-scales/contracts";
import { cn, formatDuration, relativeFrom } from "@/lib/utils";

const TAB_STATUS: Array<{ value: string; label: string; status: ContentStatus | null; countKey: keyof QueueCounts | null }> = [
  { value: "ALL", label: "All", status: null, countKey: null },
  { value: "IDEA", label: "Ideas", status: "IDEA", countKey: "ideas" },
  { value: "BRIEF", label: "Briefs", status: "BRIEF", countKey: "briefs" },
  { value: "SCRIPT", label: "Scripts", status: "SCRIPT", countKey: "scripts" },
  { value: "ASSET_READY", label: "Assets", status: "ASSET_READY", countKey: "assetsReady" },
  { value: "GENERATING", label: "Generating", status: "GENERATING", countKey: "generating" },
  { value: "NEEDS_REVIEW", label: "Needs review", status: "NEEDS_REVIEW", countKey: "needsReview" },
  { value: "APPROVED", label: "Approved", status: "APPROVED", countKey: "approved" },
  { value: "SCHEDULED", label: "Scheduled", status: "SCHEDULED", countKey: "scheduled" },
  { value: "PUBLISHED", label: "Published", status: "PUBLISHED", countKey: "published" },
  { value: "FAILED", label: "Failed", status: "FAILED", countKey: "failed" },
];

export function ContentQueue({
  items,
  counts,
  clients,
  filters,
  pillarNames,
}: {
  items: ContentItem[];
  counts: QueueCounts;
  clients: Client[];
  filters: { status: string; clientId: string; platform: string; search: string };
  pillarNames: Record<string, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [search, setSearch] = React.useState(filters.search);
  const [selected, setSelected] = React.useState<ContentItem | null>(null);
  const [approving, setApproving] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const setParam = React.useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      router.push(`${pathname}?${params.toString()}`);
    },
    [pathname, router, searchParams],
  );

  const tabs: TabItem[] = TAB_STATUS.map((tab) => ({
    value: tab.value,
    label: tab.label,
    count: tab.countKey ? counts[tab.countKey] : Object.values(counts).reduce((a, b) => a + b, 0),
  }));

  const approve = async (item: ContentItem) => {
    setApproving(true);
    setActionError(null);
    const result = await approveContentAction(item.id);
    setApproving(false);
    if (!result.ok) {
      setActionError(result.error);
      return;
    }
    setSelected(result.data);
    router.refresh();
  };

  const now = new Date();

  return (
    <>
      <Panel>
        <PanelHeader
          eyebrow="Content queue"
          title={`${items.length} item${items.length === 1 ? "" : "s"}`}
          description="Every piece of content and exactly where it is in the lifecycle."
        />
        <PanelBody className="pb-3">
          <Tabs
            ariaLabel="Filter content by lifecycle status"
            items={tabs}
            value={filters.status || "ALL"}
            onChange={(value) => setParam("status", value === "ALL" ? null : value)}
            size="sm"
            className="w-full"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <form
              className="relative min-w-[220px] flex-1"
              onSubmit={(event) => {
                event.preventDefault();
                setParam("search", search.trim() || null);
              }}
            >
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search titles and hooks"
                aria-label="Search content"
                className="h-9 pl-9"
              />
            </form>

            <Select
              aria-label="Filter by client"
              value={filters.clientId}
              onChange={(event) => setParam("clientId", event.target.value || null)}
              className="h-9 w-[180px]"
            >
              <option value="">All clients</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </Select>

            <Select
              aria-label="Filter by platform"
              value={filters.platform}
              onChange={(event) => setParam("platform", event.target.value || null)}
              className="h-9 w-[160px]"
            >
              <option value="">All platforms</option>
              {PLATFORMS.map((platform) => (
                <option key={platform} value={platform}>
                  {PLATFORM_META[platform].label}
                </option>
              ))}
            </Select>

            {filters.status || filters.clientId || filters.platform || filters.search ? (
              <Button variant="ghost" size="sm" onClick={() => router.push(pathname)}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </PanelBody>

        <PanelBody>
          {items.length === 0 ? (
            <EmptyState
              icon={<Inbox className="size-6" />}
              title="Nothing matches these filters"
              description="Try a different lifecycle stage, or clear the filters to see the whole queue."
              action={
                <Button variant="secondary" size="sm" onClick={() => router.push(pathname)}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(item);
                      setActionError(null);
                    }}
                    className="flex w-full items-center gap-3.5 rounded-[var(--radius-card)] border border-hairline bg-surface-2/55 p-3 text-left transition-colors hover:border-accent/30 hover:bg-surface-3/50"
                  >
                    <Thumb
                      tone={item.thumbnailTone}
                      platform={item.platform}
                      duration={item.durationSec ? formatDuration(item.durationSec) : undefined}
                      className="h-16 w-[76px] shrink-0"
                    />

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-medium text-ink">{item.title}</p>
                      <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-muted">{item.hook}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                        <span>{item.clientName}</span>
                        <span className="text-hairline-strong">·</span>
                        <span>{pillarNames[item.pillarId] ?? "Unassigned pillar"}</span>
                        {item.plannedPublishAt ? (
                          <>
                            <span className="text-hairline-strong">·</span>
                            <span>
                              {new Date(item.plannedPublishAt).toLocaleString("en-GB", {
                                weekday: "short",
                                day: "numeric",
                                month: "short",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      <StatusBadge status={item.status} />
                      {/* Only show the job badge when it says something the lifecycle badge does not. */}
                      {item.generation &&
                      GENERATION_STATUS_META[item.generation.status].label !==
                        CONTENT_STATUS_META[item.status].label ? (
                        <GenerationBadge status={item.generation.status} />
                      ) : null}
                      <span className="text-[10.5px] text-ink-faint">{relativeFrom(item.updatedAt, now)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </PanelBody>
      </Panel>

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
            <div className="flex flex-col gap-2">
              {actionError ? (
                <p role="alert" className="text-[12px] text-danger">
                  {actionError}
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                <LinkButton href={`/studio?contentItemId=${selected.id}`} variant="secondary" size="sm" className="flex-1">
                  Open in Studio
                </LinkButton>
                {selected.status === "NEEDS_REVIEW" ? (
                  <Button variant="primary" size="sm" className="flex-1" onClick={() => approve(selected)} disabled={approving}>
                    {approving ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />}
                    Approve
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null
        }
      >
        {selected ? (
          <div className="flex flex-col gap-4">
            <Thumb
              tone={selected.thumbnailTone}
              platform={selected.platform}
              duration={selected.durationSec ? formatDuration(selected.durationSec) : undefined}
              className="aspect-[9/16] w-full max-w-[220px]"
            />

            <div>
              <p className="ss-eyebrow">Hook</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink">{selected.hook}</p>
            </div>

            <dl className="flex flex-col">
              {[
                ["Lifecycle status", <StatusBadge key="s" status={selected.status} />],
                ["Content pillar", pillarNames[selected.pillarId] ?? "Unassigned"],
                [
                  "Planned publish",
                  selected.plannedPublishAt
                    ? new Date(selected.plannedPublishAt).toLocaleString("en-GB", {
                        weekday: "long",
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "Not scheduled",
                ],
                ["Duration", formatDuration(selected.durationSec)],
                ["Assets attached", selected.assetIds.length],
                ["Last updated", relativeFrom(selected.updatedAt, now)],
              ].map(([label, value]) => (
                <div key={label as string} className="flex items-center justify-between gap-3 border-b border-hairline py-2.5 last:border-b-0">
                  <dt className="text-[12px] text-ink-muted">{label}</dt>
                  <dd className="text-right text-[12.5px] text-ink">{value}</dd>
                </div>
              ))}
            </dl>

            {selected.generation ? (
              <div className="rounded-[var(--radius-card)] border border-hairline bg-surface-2/60 p-3.5">
                <div className="flex items-center justify-between">
                  <p className="ss-eyebrow">Generation job</p>
                  <GenerationBadge status={selected.generation.status} />
                </div>
                <Progress
                  value={selected.generation.progress}
                  className="mt-3"
                  barClassName={cn(selected.generation.status === "FAILED" && "bg-danger")}
                />
                <div className="mt-2.5 flex flex-col gap-1 text-[11.5px] text-ink-muted">
                  <span>Job {selected.generation.generationJobId}</span>
                  <span>QA: {selected.generation.qaStatus.toLowerCase()}</span>
                  {selected.generation.failureReason ? (
                    <span className="text-danger">{selected.generation.failureReason}</span>
                  ) : null}
                </div>
                <p className="mt-3 border-t border-hairline pt-2.5 text-[11px] leading-snug text-ink-faint">
                  Render output is supplied by the backend generation pipeline. In the standalone build there is no
                  video file to play.
                </p>
              </div>
            ) : null}

            <Link
              href={`/calendar?focus=${selected.id}`}
              className="text-[12.5px] text-accent underline-offset-4 hover:underline"
            >
              Show in calendar
            </Link>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
