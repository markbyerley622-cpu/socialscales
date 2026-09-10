import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { prisma } from "@/server/db";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardHeader,
  EmptyState,
  ProjectDot,
  SectionLabel,
} from "@/components/ui/ops-primitives";
import { buttonClass } from "@/components/ui/button-styles";
import { PostStatusBadge, PlatformIcon } from "@/components/ui/status";
import { minuteOfDayLabel, dayName, timeLabel, relativeTime } from "@/lib/utils";
import { PostStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Calendar" };
export const dynamic = "force-dynamic";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Month grid plus a queue list.
 *
 * Rendered server-side from real scheduled times rather than a drag surface: the
 * time a post goes out is set on the post itself (approve, or reschedule), so the
 * calendar's job is to show the shape of the month and where the gaps are.
 */
export default async function CalendarPage(props: PageProps<"/ops/calendar">) {
  const params = await props.searchParams;
  const monthParam = typeof params.month === "string" ? params.month : undefined;

  const anchor = parseMonth(monthParam);
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);

  const [posts, schedules] = await Promise.all([
    prisma.post.findMany({
      where: {
        scheduledFor: { gte: gridStart(monthStart), lt: gridEnd(monthEnd) },
        status: { not: PostStatus.ARCHIVED },
      },
      orderBy: { scheduledFor: "asc" },
      include: {
        project: { select: { name: true, accentColor: true, slug: true } },
        variant: { select: { hook: true } },
        targets: { select: { platform: true } },
      },
    }),
    prisma.schedule.findMany({
      where: { isDefault: true },
      include: {
        project: { select: { name: true, accentColor: true } },
        slots: { orderBy: [{ dayOfWeek: "asc" }, { minuteOfDay: "asc" }] },
      },
    }),
  ]);

  const days = buildGrid(monthStart, monthEnd);
  const byDay = new Map<string, typeof posts>();
  for (const post of posts) {
    if (!post.scheduledFor) continue;
    const key = dayKey(post.scheduledFor);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(post);
    else byDay.set(key, [post]);
  }

  const upcoming = posts
    .filter((post) => post.scheduledFor && post.scheduledFor >= new Date())
    .slice(0, 12);

  const monthLabel = monthStart.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Where the month actually stands, per project. Times are the post's own scheduled time in your local zone."
        actions={
          <div className="flex items-center gap-1">
            <Link
              href={`/ops/calendar?month=${monthKey(addMonths(monthStart, -1))}`}
              className={buttonClass("secondary", "sm")}
              aria-label="Previous month"
            >
              <ChevronLeft />
            </Link>
            <Link href="/ops/calendar" className={buttonClass("ghost", "sm")}>
              Today
            </Link>
            <Link
              href={`/ops/calendar?month=${monthKey(addMonths(monthStart, 1))}`}
              className={buttonClass("secondary", "sm")}
              aria-label="Next month"
            >
              <ChevronRight />
            </Link>
          </div>
        }
      />

      <PageBody className="space-y-4">
        <Card>
          <CardHeader
            title={monthLabel}
            subtitle={`${posts.length} post${posts.length === 1 ? "" : "s"} in view.`}
          />
          <div className="overflow-x-auto p-3">
            <div className="min-w-[52rem]">
              <div className="grid grid-cols-7 gap-1.5">
                {WEEKDAY_LABELS.map((label) => (
                  <div
                    key={label}
                    className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted"
                  >
                    {label}
                  </div>
                ))}
                {days.map((day) => {
                  const key = dayKey(day.date);
                  const dayPosts = byDay.get(key) ?? [];
                  return (
                    <div
                      key={key}
                      className={`min-h-[5.5rem] rounded-md border p-1.5 ${
                        day.inMonth
                          ? "border-hairline bg-surface"
                          : "border-hairline/50 bg-surface/40"
                      } ${day.isToday ? "ring-1 ring-accent/50" : ""}`}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span
                          className={`text-[10.5px] tabular ${
                            day.inMonth ? "text-ink-secondary" : "text-ink-muted"
                          }`}
                        >
                          {day.date.getDate()}
                        </span>
                        {dayPosts.length > 2 ? (
                          <span className="text-[9.5px] tabular text-ink-muted">
                            {dayPosts.length}
                          </span>
                        ) : null}
                      </div>
                      <ul className="space-y-1">
                        {dayPosts.slice(0, 3).map((post) => (
                          <li key={post.id}>
                            <Link
                              href={`/ops/content/${post.assetId}`}
                              className="block rounded border-l-2 bg-surface-raised px-1.5 py-1 transition-colors hover:bg-surface-hover"
                              style={{ borderColor: post.project.accentColor }}
                            >
                              <span className="block text-[9.5px] tabular text-ink-muted">
                                {post.scheduledFor ? timeLabel(post.scheduledFor) : ""}
                              </span>
                              <span className="block truncate text-[10.5px] leading-tight text-ink">
                                {post.variant.hook}
                              </span>
                            </Link>
                          </li>
                        ))}
                        {dayPosts.length > 3 ? (
                          <li className="px-1.5 text-[9.5px] text-ink-muted">
                            +{dayPosts.length - 3} more
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <Card>
            <CardHeader
              title="Queue"
              subtitle="The next twelve, in order."
            />
            {upcoming.length === 0 ? (
              <EmptyState
                icon={<CalendarDays />}
                title="Nothing upcoming"
                body="Approve a post and give it a time; it will appear here and in the grid above."
              />
            ) : (
              <ul className="divide-y divide-hairline">
                {upcoming.map((post) => (
                  <li key={post.id} className="flex items-start gap-3 px-4 py-2.5">
                    <div className="w-[7.5rem] shrink-0">
                      <p className="text-[11.5px] tabular text-ink">
                        {post.scheduledFor
                          ? post.scheduledFor.toLocaleDateString(undefined, {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                            })
                          : "—"}
                      </p>
                      <p className="text-[10.5px] tabular text-ink-muted">
                        {post.scheduledFor ? timeLabel(post.scheduledFor) : ""}
                      </p>
                    </div>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/ops/content/${post.assetId}`}
                        className="block truncate text-[12.5px] text-ink hover:underline"
                      >
                        {post.variant.hook}
                      </Link>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <ProjectDot color={post.project.accentColor} />
                        <span className="text-[10.5px] text-ink-muted">
                          {post.project.name}
                        </span>
                        {post.targets.map((target, index) => (
                          <PlatformIcon key={index} platform={target.platform} />
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <PostStatusBadge status={post.status} />
                      <span className="text-[10px] tabular text-ink-muted">
                        {post.scheduledFor ? relativeTime(post.scheduledFor) : ""}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Recurring windows"
              subtitle="Each project's own cadence, used as the default when scheduling."
            />
            <div className="space-y-3 px-4 py-3.5">
              {schedules.map((schedule) => (
                <div key={schedule.id}>
                  <div className="flex items-center gap-2">
                    <ProjectDot color={schedule.project.accentColor} />
                    <SectionLabel>{schedule.project.name}</SectionLabel>
                    <span className="text-[10px] text-ink-muted">
                      {schedule.timezone}
                    </span>
                  </div>
                  <ul className="mt-1.5 space-y-0.5">
                    {schedule.slots.map((slot) => (
                      <li
                        key={slot.id}
                        className="flex items-baseline justify-between gap-3 text-[11.5px]"
                      >
                        <span className="text-ink-secondary">
                          {dayName(slot.dayOfWeek)}
                        </span>
                        <span className="tabular text-ink-muted">
                          {minuteOfDayLabel(slot.minuteOfDay)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  );
}

// ---------------------------------------------------------------------------

function parseMonth(value: string | undefined): Date {
  if (value && /^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    return new Date(year, month - 1, 1);
  }
  return new Date();
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The grid starts on the Sunday at or before the 1st. */
function gridStart(monthStart: Date): Date {
  const start = new Date(monthStart);
  start.setDate(start.getDate() - start.getDay());
  start.setHours(0, 0, 0, 0);
  return start;
}

/** ...and ends on the Saturday at or after the last day. */
function gridEnd(monthEnd: Date): Date {
  const end = new Date(monthEnd);
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));
  end.setHours(23, 59, 59, 999);
  return end;
}

function buildGrid(
  monthStart: Date,
  monthEnd: Date,
): Array<{ date: Date; inMonth: boolean; isToday: boolean }> {
  const days: Array<{ date: Date; inMonth: boolean; isToday: boolean }> = [];
  const todayKey = dayKey(new Date());
  const cursor = gridStart(monthStart);

  // Always render whole weeks, so the grid never has ragged edges.
  while (cursor < monthEnd || cursor.getDay() !== 0) {
    const date = new Date(cursor);
    days.push({
      date,
      inMonth: date.getMonth() === monthStart.getMonth(),
      isToday: dayKey(date) === todayKey,
    });
    cursor.setDate(cursor.getDate() + 1);
    if (days.length >= 42) break;
  }
  return days;
}
