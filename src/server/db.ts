import "@/lib/load-env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/env";

/**
 * Prisma 7 requires an explicit driver adapter. The client is cached on
 * globalThis so Next's dev-time module reloading does not open a new pool on
 * every edit.
 */
const globalForPrisma = globalThis as unknown as {
  contentOsPrisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.databaseUrl });
  return new PrismaClient({
    adapter,
    log: env.nodeEnv === "development" ? ["warn", "error"] : ["error"],
  });
}

function client(): PrismaClient {
  const existing = globalForPrisma.contentOsPrisma;
  if (existing) return existing;

  const created = createClient();
  // Cached in development so Next's module reloading does not open a new pool
  // on every edit. In production each serverless instance gets its own.
  if (env.nodeEnv !== "production") globalForPrisma.contentOsPrisma = created;
  else globalForPrisma.contentOsPrisma = created;
  return created;
}

/**
 * The Prisma client, constructed on first use rather than on import.
 *
 * Importing this module must not require DATABASE_URL. A build collects page
 * data by importing every route, and a throw there fails the build — which
 * leaves the previous deployment live and its stale data on screen. Deferring
 * construction to the first query means a misconfigured deployment still ships
 * and then says so, which is the behaviour this system needs.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(client(), property, receiver);
    return typeof value === "function" ? value.bind(client()) : value;
  },
  has(_target, property) {
    return Reflect.has(client(), property);
  },
});
