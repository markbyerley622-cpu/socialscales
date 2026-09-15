import { NextResponse } from "next/server";

import { prisma } from "@/server/db";
import { resolveDataSource } from "@/lib/social-scales/data-source";
import { resolveAuthConfig, type AuthConfigDecision } from "@/server/auth/config";
import { buildInfo } from "@/lib/build-info";

/**
 * What this deployment is, and what it is actually reading from.
 *
 * Deliberately public and unauthenticated — it exists so a deployment can be
 * verified without a browser and without credentials, which is exactly when you
 * most need to know whether the site is serving real data. That constraint also
 * sets its limits: it reports counts, never records, and never an environment
 * variable's value.
 *
 * `commit` is the reason this endpoint can settle "is production running the
 * code I pushed?" — the question that started this whole investigation, and one
 * that took a 404 probe to answer last time.
 *
 * `auth` is the reason it can settle "can anyone actually sign in?". A
 * deployment missing `AUTH_COOKIE_SECRET` reported `ok` here while being unable
 * to complete a single sign-in — see `src/server/auth/config.ts` for why that
 * stayed invisible until a correct password arrived.
 */

export const dynamic = "force-dynamic";

/** Presence and format only. Never a value — this response is public. */
function authSection(decision: AuthConfigDecision) {
  return decision.ok ? { usable: true } : { usable: false, problems: decision.problems };
}

export async function GET(): Promise<NextResponse> {
  const source = resolveDataSource();
  const auth = resolveAuthConfig();
  const build = buildInfo();

  if (!source.ok) {
    // A misconfigured deployment is unhealthy, and says which variable is wrong.
    return NextResponse.json(
      {
        status: "misconfigured",
        build,
        dataSource: { mode: source.requested, usable: false, problem: source.problem },
        auth: authSection(auth),
        database: { reachable: false },
      },
      { status: 503 },
    );
  }

  if (source.mode !== "prisma") {
    return NextResponse.json(
      {
        status: !auth.ok ? "misconfigured" : source.isDemo ? "demo" : "ok",
        build,
        dataSource: {
          mode: source.mode,
          usable: true,
          isDemo: source.isDemo,
          summary: source.summary,
        },
        auth: authSection(auth),
        database: { reachable: null, note: "This mode does not read the local database." },
      },
      // A demo deployment is not "ok". Anything polling this should notice.
      { status: source.isDemo || !auth.ok ? 503 : 200 },
    );
  }

  try {
    const [
      projects,
      posts,
      accounts,
      snapshots,
      realSnapshots,
      renderQueued,
      renderRunning,
      renderFailed,
      worker,
    ] = await Promise.all([
      prisma.project.count(),
      prisma.post.count(),
      prisma.socialAccount.count(),
      prisma.analyticsSnapshot.count(),
      prisma.analyticsSnapshot.count({ where: { source: { not: "SIMULATED" } } }),
      prisma.renderJob.count({ where: { status: "PENDING" } }),
      prisma.renderJob.count({ where: { status: "RUNNING" } }),
      prisma.renderJob.count({ where: { status: "FAILED" } }),
      prisma.workerStatus.findFirst({ orderBy: { lastSeenAt: "desc" } }),
    ]);

    // A worker that has not checked in for two minutes is not running. The
    // heartbeat interval is one minute, so this tolerates a single missed beat.
    const heartbeatAgeMs = worker ? Date.now() - worker.lastSeenAt.getTime() : null;
    const workerAlive = heartbeatAgeMs !== null && heartbeatAgeMs < 120_000;

    return NextResponse.json(
      {
        // A deployment nobody can sign in to is not healthy, however much of the
        // rest of it works. The counts are still reported: losing them on a
        // configuration fault would trade one blind spot for another.
        status: auth.ok ? "ok" : "misconfigured",
        build,
        dataSource: { mode: "prisma", usable: true, isDemo: false, summary: source.summary },
        auth: authSection(auth),
        database: { reachable: true, projects, posts, socialAccounts: accounts },
        analytics: {
          snapshots,
          // The dashboard renders a demo badge from this. Simulated numbers are
          // real rows in a real database, and still not measurements.
          allSimulated: snapshots > 0 && realSnapshots === 0,
        },
        renderQueue: { queued: renderQueued, running: renderRunning, failed: renderFailed },
        worker: worker
          ? {
              alive: workerAlive,
              id: worker.id,
              hostname: worker.hostname,
              startedAt: worker.startedAt.toISOString(),
              lastSeenAt: worker.lastSeenAt.toISOString(),
              heartbeatAgeSeconds: Math.round((heartbeatAgeMs ?? 0) / 1000),
              livePublishing: worker.livePublishing,
              // Queued work is not lost when no worker is running; it waits.
              note: workerAlive
                ? null
                : "No worker has checked in recently. Render and publish jobs will stay queued until one connects.",
            }
          : {
              alive: false,
              note: "No worker has ever checked in. Render and publish jobs will stay queued until one connects.",
            },
      },
      { status: auth.ok ? 200 : 503 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: "database-unreachable",
        build,
        dataSource: { mode: "prisma", usable: true, summary: source.summary },
        auth: authSection(auth),
        database: {
          reachable: false,
          // Prisma redacts credentials from connection errors, so this is safe
          // to return; it is truncated anyway.
          problem: error instanceof Error ? error.message.slice(0, 300) : String(error),
        },
      },
      { status: 503 },
    );
  }
}
