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
    url: process.env["DATABASE_URL"],
  },
});
