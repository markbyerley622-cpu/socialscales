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

export const prisma: PrismaClient =
  globalForPrisma.contentOsPrisma ?? createClient();

if (env.nodeEnv !== "production") {
  globalForPrisma.contentOsPrisma = prisma;
}
