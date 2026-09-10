import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, LogOut } from "lucide-react";
import { effectivePublishingMode } from "@/server/jobs/worker-status";
import { prisma } from "@/server/db";
import { getCurrentUser } from "@/server/auth/session";
import { logoutAction } from "@/app/actions/auth";
import { Sidebar, type SidebarCounts } from "@/components/nav/sidebar";
import { Button } from "@/components/ui/button";
import { initials } from "@/lib/utils";
import {
  ApprovalState,
  JobStatus,
  PostStatus,
  RecommendationStatus,
} from "@/generated/prisma/enums";

/**
 * The console shell. Every page inside this group is behind a real session
 * check — the proxy only screens malformed cookies, so this is where an expired
 * or revoked session is actually caught.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const [publishing, needsApproval, queued, failed, openRecommendations] = await Promise.all([
    effectivePublishingMode(),
    prisma.post.count({ where: { approvalState: ApprovalState.PENDING } }),
    prisma.publishJob.count({
      where: { status: { in: [JobStatus.PENDING, JobStatus.QUEUED] } },
    }),
    prisma.post.count({ where: { status: PostStatus.FAILED } }),
    prisma.recommendation.count({ where: { status: RecommendationStatus.OPEN } }),
  ]);

  const counts: SidebarCounts = {
    needsApproval,
    queued,
    failed,
    openRecommendations,
  };

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-[13.5rem] shrink-0 flex-col border-r border-hairline bg-plane/80 backdrop-blur md:flex">
        <div className="flex h-12 items-center gap-2 border-b border-hairline px-4">
          <span
            aria-hidden
            className="grid size-[22px] place-items-center rounded-[5px] bg-accent text-[11px] font-bold text-[#0d0b1c]"
          >
            C
          </span>
          <span className="text-[11.5px] font-semibold tracking-[0.16em] text-ink">
            CONTENT OS
          </span>
        </div>

        <div className="min-h-0 flex-1">
          <Sidebar counts={counts} />
        </div>

        <div className="border-t border-hairline px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="grid size-6 shrink-0 place-items-center rounded-full border border-hairline-strong bg-surface-raised text-[10px] font-semibold text-ink-secondary"
            >
              {initials(user.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[11.5px] text-ink">{user.name}</p>
              <p className="truncate text-[10px] text-ink-muted">{user.email}</p>
            </div>
            <form action={logoutAction}>
              <Button
                variant="ghost"
                size="sm"
                type="submit"
                aria-label="Sign out"
                className="px-1.5"
              >
                <LogOut />
              </Button>
            </form>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile nav: the console is desktop-first, but must not be unusable. */}
        <div className="border-b border-hairline bg-plane px-4 py-2 md:hidden">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-semibold tracking-[0.16em] text-ink">
              CONTENT OS
            </span>
            <form action={logoutAction}>
              <Button variant="ghost" size="sm" type="submit">
                <LogOut />
                Sign out
              </Button>
            </form>
          </div>
          <div className="-mx-4 mt-2 overflow-x-auto px-4">
            <div className="flex w-max gap-1.5 pb-1">
              {[
                ["/", "Overview"],
                ["/projects", "Projects"],
                ["/content", "Content"],
                ["/calendar", "Calendar"],
                ["/approvals", "Approvals"],
                ["/queue", "Queue"],
                ["/analytics", "Analytics"],
                ["/recommendations", "Recommendations"],
              ].map(([href, label]) => (
                <Link
                  key={href}
                  href={href}
                  className="rounded-md border border-hairline bg-surface px-2 py-1 text-[11.5px] text-ink-secondary"
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/*
          Reports the WORKER's mode, not this process's. The worker is what
          publishes, and in a real deployment the two processes have separate
          environments — a console that says "simulation" while the worker
          publishes for real would be worse than showing nothing.
        */}
        {publishing.live ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-[11.5px] text-[#f6c455]">
            <AlertTriangle className="size-3.5 shrink-0" />
            Live publishing is enabled. Approved posts will be published to real
            accounts by the worker.
            {publishing.source === "local-config" ? (
              <span className="text-ink-muted">
                (from this process&rsquo;s configuration — no worker has checked in)
              </span>
            ) : null}
            {publishing.disagrees ? (
              <span className="text-[#ec7d7d]">
                The web process is configured for simulation; the worker decides, and
                it is live.
              </span>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-surface/60 px-4 py-1.5 text-[11px] text-ink-muted">
            <AlertTriangle className="size-3.5 shrink-0 text-serious" />
            Simulation mode: the worker runs the publish simulator and all metrics
            are labelled <span className="text-ink-secondary">Simulated</span>. Set{" "}
            <code className="text-ink-secondary">ENABLE_LIVE_PUBLISHING=1</code> to
            publish for real.
            {publishing.source === "local-config" ? (
              <span>· no worker has checked in, so this is this process&rsquo;s own setting</span>
            ) : null}
            {publishing.disagrees ? (
              <span className="text-[#f6c455]">
                · this process is configured for live publishing, but the worker is not
              </span>
            ) : null}
          </div>
        )}

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
