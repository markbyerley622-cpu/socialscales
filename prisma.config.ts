import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Standalone on purpose: the Prisma CLI loads this file before any app code.
config({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    /**
     * Migrations connect directly; the running app connects through the pooler.
     *
     * Hosted Postgres providers (Neon, Supabase, and Vercel's own) put PgBouncer
     * in front of the database in transaction-pooling mode, which is right for
     * serverless request traffic and wrong for DDL — `prisma migrate deploy`
     * needs session-level features a transaction pooler does not offer, and
     * fails in ways that look like network errors.
     *
     * So the CLI prefers DIRECT_URL when it is set and falls back to
     * DATABASE_URL when it is not, which keeps a single-URL provider working
     * with no extra configuration.
     */
    url: process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"],
  },
});
