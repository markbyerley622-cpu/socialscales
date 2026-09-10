import { config } from "dotenv";

// Next.js loads .env.local on its own, but the BullMQ worker, the Prisma CLI and
// vitest do not. Importing this module first gives every entry point the same
// environment. dotenv does not overwrite variables that are already set, so a
// real deployment can keep injecting them itself.
config({ path: [".env.local", ".env"], quiet: true });
