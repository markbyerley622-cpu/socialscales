import { NextResponse } from "next/server";

import { prisma } from "@/server/db";
import { resolveDataSource } from "@/lib/social-scales/data-source";

/**
 * What this deployment is actually reading from.
 *
 * Deliberately public and deliberately unauthenticated — it exists so a
 * deployment can be verified without a browser and without credentials, which
 * is exactly when you most need to know whether the site is serving real data.
 *
 * It reports no records, only whether they exist and where they come from. The
 * counts are the smallest thing that distinguishes "connected to a real
 * database" from "showing fixtures", which is the question this endpoint is for.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const source = resolveDataSource();

  if (!source.ok) {
    // A misconfigured deployment is unhealthy, and says so with the reason.
    return NextResponse.json(
      {
        status: "misconfigured",
        dataSource: { mode: source.requested, usable: false, problem: source.problem },
        database: { reachable: false },
      },
      { status: 503 },
    );
  }

  if (source.mode !== "prisma") {
    return NextResponse.json({
      status: source.isDemo ? "demo" : "ok",
      dataSource: { mode: source.mode, usable: true, isDemo: source.isDemo, summary: source.summary },
      database: { reachable: null, note: "This mode does not read the local database." },
    });
  }

  try {
    const [projects, posts, accounts, snapshots, realSnapshots] = await Promise.all([
      prisma.project.count(),
      prisma.post.count(),
      prisma.socialAccount.count(),
      prisma.analyticsSnapshot.count(),
      prisma.analyticsSnapshot.count({ where: { source: { not: "SIMULATED" } } }),
    ]);

    return NextResponse.json({
      status: "ok",
      dataSource: { mode: "prisma", usable: true, isDemo: false, summary: source.summary },
      database: { reachable: true, projects, posts, socialAccounts: accounts },
      analytics: {
        snapshots,
        // The dashboard renders a demo badge from this. Simulated numbers are
        // real rows in a real database, and still not measurements.
        allSimulated: snapshots > 0 && realSnapshots === 0,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "database-unreachable",
        dataSource: { mode: "prisma", usable: true, summary: source.summary },
        database: {
          reachable: false,
          // The message can name a host; it never contains the password, because
          // Prisma redacts credentials from connection errors.
          problem: error instanceof Error ? error.message.slice(0, 300) : String(error),
        },
      },
      { status: 503 },
    );
  }
}
