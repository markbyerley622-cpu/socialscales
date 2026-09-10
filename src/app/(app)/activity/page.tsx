import type { Metadata } from "next";
import Link from "next/link";
import { Activity as ActivityIcon, AlertTriangle } from "lucide-react";
import { prisma } from "@/server/db";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ProjectDot,
} from "@/components/ui/primitives";
import { buttonClass } from "@/components/ui/button-styles";
import { dateTimeLabel, humanize, relativeTime } from "@/lib/utils";
import { ActorType } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

const ACTOR_TONE: Record<ActorType, "neutral" | "accent" | "info"> = {
  USER: "accent",
  SYSTEM: "neutral",
  WORKER: "info",
};

/**
 * The audit trail. Every state change in the system writes here through a single
 * function, which is what makes this complete rather than partial.
 */
export default async function ActivityPage(props: PageProps<"/activity">) {
  const params = await props.searchParams;
  const projectSlug = typeof params.project === "string" ? params.project : undefined;
  const page = Math.max(1, Number(params.page ?? 1) || 1);

  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, slug: true, name: true, accentColor: true },
  });
  const active = projects.find((project) => project.slug === projectSlug) ?? null;

  const where = active ? { projectId: active.id } : {};

  const [entries, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        project: { select: { name: true, accentColor: true } },
        user: { select: { name: true } },
      },
    }),
    prisma.activityLog.count({ where }),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Activity"
        description={`${total.toLocaleString()} recorded events. Uploads, AI runs, approvals, schedule changes, publish attempts, analytics syncs and sign-ins.`}
      />

      <PageBody className="space-y-4">
        <nav aria-label="Filter by project" className="flex flex-wrap gap-1.5">
          <Link
            href="/activity"
            aria-current={active ? undefined : "page"}
            className={`rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
              active
                ? "border-hairline bg-surface text-ink-secondary hover:text-ink"
                : "border-hairline-strong bg-surface-raised text-ink"
            }`}
          >
            Everything
          </Link>
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/activity?project=${project.slug}`}
              aria-current={active?.id === project.id ? "page" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                active?.id === project.id
                  ? "border-hairline-strong bg-surface-raised text-ink"
                  : "border-hairline bg-surface text-ink-secondary hover:text-ink"
              }`}
            >
              <ProjectDot color={project.accentColor} />
              {project.name}
            </Link>
          ))}
        </nav>

        <Card>
          <CardHeader
            title="Event stream"
            subtitle={`Page ${page} of ${pages}, newest first.`}
          />
          {entries.length === 0 ? (
            <EmptyState
              icon={<ActivityIcon />}
              title="No events"
              body="Activity is written whenever anything happens. An empty log means nothing has yet."
            />
          ) : (
            <ul className="divide-y divide-hairline">
              {entries.map((entry) => {
                const isFailure = entry.action.includes("failed");
                return (
                  <li key={entry.id} className="flex items-start gap-3 px-4 py-2.5">
                    <span className="w-[7.5rem] shrink-0 text-[10.5px] tabular text-ink-muted">
                      {dateTimeLabel(entry.createdAt)}
                    </span>
                    <span className="mt-0.5 shrink-0">
                      {isFailure ? (
                        <AlertTriangle className="size-3.5 text-critical" />
                      ) : (
                        <span
                          aria-hidden
                          className="mt-1 block size-1.5 rounded-full"
                          style={{
                            background:
                              entry.project?.accentColor ?? "var(--color-ink-muted)",
                          }}
                        />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className={`text-[12px] leading-snug ${
                          isFailure ? "text-[#ec7d7d]" : "text-ink"
                        }`}
                      >
                        {entry.message}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-muted">
                        <Badge tone={ACTOR_TONE[entry.actorType]}>
                          {humanize(entry.actorType)}
                        </Badge>
                        <code>{entry.action}</code>
                        {entry.project?.name ? <span>· {entry.project.name}</span> : null}
                        {entry.user?.name ? <span>· {entry.user.name}</span> : null}
                        {entry.entityType ? (
                          <span>
                            · {entry.entityType} {entry.entityId?.slice(0, 8)}
                          </span>
                        ) : null}
                        <span>· {relativeTime(entry.createdAt)}</span>
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {pages > 1 ? (
            <div className="flex items-center justify-between gap-3 border-t border-hairline px-4 py-2.5">
              {page > 1 ? (
                <Link
                  href={buildHref(active?.slug, page - 1)}
                  className={buttonClass("secondary", "sm")}
                >
                  Newer
                </Link>
              ) : (
                <span />
              )}
              <span className="text-[10.5px] tabular text-ink-muted">
                {page} / {pages}
              </span>
              {page < pages ? (
                <Link
                  href={buildHref(active?.slug, page + 1)}
                  className={buttonClass("secondary", "sm")}
                >
                  Older
                </Link>
              ) : (
                <span />
              )}
            </div>
          ) : null}
        </Card>
      </PageBody>
    </>
  );
}

function buildHref(projectSlug: string | undefined, page: number): string {
  const params = new URLSearchParams();
  if (projectSlug) params.set("project", projectSlug);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/activity?${query}` : "/activity";
}
