import { hostname } from "node:os";
import { env } from "@/env";
import { prisma } from "@/server/db";

/**
 * The worker's self-report.
 *
 * The web app cannot tell from its own configuration whether publishing is
 * actually live — the worker is a separate process with its own environment, and
 * in any real deployment the two can differ. A console that says "simulation"
 * while the worker publishes for real is actively dangerous, so the worker
 * publishes its own effective mode here and the console reads that.
 */

const SINGLETON_ID = "worker";

/** Considered offline if it has not checked in within this window. */
export const WORKER_STALE_AFTER_MS = 3 * 60 * 1000;

export async function reportWorkerStatus(startedAt: Date): Promise<void> {
  const row = {
    livePublishing: env.enableLivePublishing,
    aiProvider: env.aiProvider,
    queuePrefix: env.queuePrefix,
    startedAt,
    lastSeenAt: new Date(),
    hostname: safeHostname(),
  };
  await prisma.workerStatus.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...row },
    update: row,
  });
}

export type WorkerView = {
  online: boolean;
  livePublishing: boolean;
  aiProvider: string;
  queuePrefix: string;
  lastSeenAt: Date;
  startedAt: Date;
  hostname: string | null;
};

export async function readWorkerStatus(): Promise<WorkerView | null> {
  const row = await prisma.workerStatus.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return null;
  return {
    online: Date.now() - row.lastSeenAt.getTime() < WORKER_STALE_AFTER_MS,
    livePublishing: row.livePublishing,
    aiProvider: row.aiProvider,
    queuePrefix: row.queuePrefix,
    lastSeenAt: row.lastSeenAt,
    startedAt: row.startedAt,
    hostname: row.hostname,
  };
}

/**
 * The authoritative answer to "is publishing live right now?".
 *
 * A live worker wins over local configuration, because the worker is what
 * publishes. When no worker has checked in, this falls back to the local flag
 * and says so, so the UI can present an honest "unconfirmed" rather than a
 * confident wrong answer.
 */
export async function effectivePublishingMode(): Promise<{
  live: boolean;
  source: "worker" | "local-config";
  workerOnline: boolean;
  disagrees: boolean;
}> {
  const worker = await readWorkerStatus();
  if (!worker || !worker.online) {
    return {
      live: env.enableLivePublishing,
      source: "local-config",
      workerOnline: false,
      disagrees: false,
    };
  }
  return {
    live: worker.livePublishing,
    source: "worker",
    workerOnline: true,
    disagrees: worker.livePublishing !== env.enableLivePublishing,
  };
}

/** Hostnames can identify a machine; keep it short and non-sensitive. */
function safeHostname(): string | null {
  try {
    return hostname().slice(0, 60);
  } catch {
    return null;
  }
}
