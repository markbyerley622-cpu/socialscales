import { NextResponse } from "next/server";

import { prisma } from "@/server/db";
import { resolveDataSource } from "@/lib/social-scales/data-source";
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
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const source = resolveDataSource();
  const build = buildInfo();

  if (!source.ok) {
    // A misconfigured deployment is unhealthy, and says which variable is wrong.
    return NextResponse.json(
      {
        status: "misconfigured",
        build,
        dataSource: { mode: source.requested, usable: false, problem: source.problem },
        database: { reachable: false },
      },
      { status: 503 },
    );
  }

  if (source.mode !== "prisma") {
    return NextResponse.json(
      {
        status: source.isDemo ? "demo" : "ok",
        build,
        dataSource: {
          mode: source.mode,
          usable: true,
          isDemo: source.isDemo,
          summary: source.summary,
        },
        database: { reachable: null, note: "This mode does not read the local database." },
      },
      // A demo deployment is not "ok". Anything polling this should notice.
      { status: source.isDemo ? 503 : 200 },
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

    return NextResponse.json({
      status: "ok",
      build,
      dataSource: { mode: "prisma", usable: true, isDemo: false, summary: source.summary },
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
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "database-unreachable",
        build,
        dataSource: { mode: "prisma", usable: true, summary: source.summary },
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
