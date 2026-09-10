import "../src/lib/load-env";

/**
 * Test environment.
 *
 * Tests run against a SEPARATE DATABASE on the same Postgres server, never the
 * development one.
 *
 * The distinction matters more than it looks. Prisma's `?schema=` query
 * parameter is honoured by the CLI (migrations land in that schema) but is
 * ignored by the `pg` driver adapter the client uses — so a client configured
 * that way silently talks to `public`. Pointing the tests at a schema therefore
 * looks isolated while actually truncating development data. A different
 * database name is honoured by both, and `resetDatabase` additionally refuses to
 * run against a database whose name does not end in `_test`.
 */

const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!source) {
  throw new Error(
    "Set DATABASE_URL (or TEST_DATABASE_URL) before running the tests. `npm run db:up` starts the local Postgres.",
  );
}

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? toTestDatabase(source);

// Deterministic, non-secret keys: these exist so crypto has valid inputs, and
// are never used against real data.
process.env.SESSION_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.AUTH_COOKIE_SECRET ??= "test-cookie-secret-not-used-in-production";
process.env.ENABLE_LIVE_PUBLISHING = "0";
process.env.AI_PROVIDER = "heuristic";
process.env.STORAGE_DIR = "./storage/test";
// Namespaces the BullMQ keys so a Redis-backed test can never consume, promote
// or delete a development job.
process.env.QUEUE_PREFIX = "bull-test";
// The simulator's failure injection is deterministic per destination id, but
// ids are random per run — so leaving it on makes roughly one run in eight fail
// for reasons unrelated to what is being tested. Tests that want the failure
// path turn it on explicitly.
process.env.SIMULATED_FAILURE_RATE = "0";

/** postgresql://…/contentos → postgresql://…/contentos_test */
export function toTestDatabase(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "") || "postgres";
  parsed.pathname = `/${name.endsWith("_test") ? name : `${name}_test`}`;
  // A schema hint here would be misleading, since the driver ignores it.
  parsed.searchParams.delete("schema");
  return parsed.toString();
}
