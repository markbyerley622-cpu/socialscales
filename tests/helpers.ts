import { execSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { Client } from "pg";
import { prisma } from "@/server/db";
import { buildSampleMp4 } from "../prisma/sample-media";
import { createAsset } from "@/server/services/content-service";
import { hashPassword } from "@/server/security/crypto";
import {
  AccountStatus,
  Platform,
  PublishPolicy,
} from "@/generated/prisma/enums";

/**
 * Shared fixtures.
 *
 * `migrateTestSchema` runs the real migrations against the test schema, so the
 * tests exercise the same DDL production gets rather than a hand-built table set.
 */

let migrated = false;

function testDatabaseName(): string {
  return new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, "");
}

/** Creates the test database if it is not there yet. Safe to call repeatedly. */
async function ensureTestDatabase(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  const name = testDatabaseName();

  // Connect to the maintenance database to issue CREATE DATABASE.
  const admin = new URL(url.toString());
  admin.pathname = "/postgres";

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const existing = await client.query(
      "select 1 from pg_database where datname = $1",
      [name],
    );
    if (existing.rowCount === 0) {
      // Identifiers cannot be parameterised; the name is derived from our own
      // connection string and is quoted.
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}

export async function migrateTestSchema(): Promise<void> {
  if (migrated) return;
  await ensureTestDatabase();
  // execSync rather than execFileSync: Node 24 on Windows refuses to spawn a
  // .cmd directly, and this command is a fixed literal with nothing to inject.
  execSync("npx prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env },
  });
  migrated = true;
}

const TABLES = [
  "AIUsageLog", "AIJob",
  "RecommendationEvidence", "StrategyEvidence", "LearningEvidence",
  "StrategyVersion", "Learning", "EvidenceSource",
  "AudienceSegment", "BusinessObjective", "Workspace",
  "ActivityLog", "Recommendation", "ExperimentVariant", "Experiment", "Trend",
  "AnalyticsSnapshot", "PublishAttempt", "PublishJob", "PostPlatform", "Post",
  "ContentVariant", "AIAnalysis", "ContentAsset", "ScheduleSlot", "Schedule",
  "PlatformSession", "SocialAccount", "Hashtag", "ContentPillar", "Brand",
  "Project", "UserSession", "User",
];

/**
 * Wipes every table.
 *
 * The guard is not paranoia: an earlier version of this setup relied on Prisma's
 * `?schema=` parameter, which the driver adapter ignores, and truncated the
 * development database instead. Asking the server which database it is actually
 * connected to — rather than trusting the configured URL — is the check that
 * would have caught it.
 */
export async function resetDatabase(): Promise<void> {
  const [{ current_database: current }] = await prisma.$queryRawUnsafe<
    Array<{ current_database: string }>
  >("select current_database()");

  if (!current.endsWith("_test")) {
    throw new Error(
      `Refusing to truncate "${current}": the tests must run against a database whose name ends in _test. Check tests/setup.ts.`,
    );
  }

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(", ")} CASCADE;`,
  );
}

export async function cleanupTestStorage(): Promise<void> {
  await rm("./storage/test", { recursive: true, force: true });
}

export async function createOperator(email = "test@contentos.local") {
  return prisma.user.create({
    data: {
      email,
      name: "Test Operator",
      passwordHash: await hashPassword("correct horse battery staple"),
    },
  });
}

export type Fixture = Awaited<ReturnType<typeof createProjectFixture>>;

/** A workspace, created on demand and reused within a test. */
export async function ensureWorkspace(slug = "test-workspace") {
  return prisma.workspace.upsert({
    where: { slug },
    create: { slug, name: "Test workspace" },
    update: {},
  });
}

export async function createProjectFixture(options: {
  slug?: string;
  publishPolicy?: PublishPolicy;
  platforms?: Platform[];
  workspaceId?: string;
} = {}) {
  const workspaceId =
    options.workspaceId ?? (await ensureWorkspace()).id;

  const project = await prisma.project.create({
    data: {
      workspaceId,
      slug: options.slug ?? `test-project-${Math.random().toString(36).slice(2, 8)}`,
      name: "Test Project",
      description: "Fixture project",
      accentColor: "#9085e9",
      publishPolicy: options.publishPolicy ?? PublishPolicy.MANUAL_APPROVAL,
      brand: {
        create: {
          audience: "test viewers",
          tone: "plain",
          valueProp: "It does the thing.",
          primaryCta: "Link in bio",
        },
      },
      pillars: { create: [{ slug: "core", name: "Core" }] },
      hashtags: { create: [{ tag: "#testing", usageCount: 3 }] },
      accounts: {
        create: (options.platforms ?? [Platform.TIKTOK]).map((platform) => ({
          platform,
          handle: `@test_${platform.toLowerCase()}`,
          status: AccountStatus.CONNECTED,
        })),
      },
    },
    include: { accounts: true, pillars: true },
  });

  return project;
}

/** A valid 9:16 MP4 the probe can read, unique per call so checksums differ. */
export function sampleVideo(options: {
  durationSeconds?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  seed?: number;
} = {}): Buffer {
  return buildSampleMp4({
    durationSeconds: options.durationSeconds ?? 24,
    width: options.width ?? 1080,
    height: options.height ?? 1920,
    hasAudio: options.hasAudio ?? true,
    payloadBytes: 2_048 + (options.seed ?? 0),
  });
}

export async function createAssetFixture(input: {
  projectId: string;
  uploaderId?: string | null;
  filename?: string;
  seed?: number;
  durationSeconds?: number;
}) {
  const { asset } = await createAsset({
    projectId: input.projectId,
    uploaderId: input.uploaderId ?? null,
    filename: input.filename ?? `fixture-${input.seed ?? 0}.mp4`,
    declaredMime: "video/mp4",
    data: sampleVideo({ seed: input.seed, durationSeconds: input.durationSeconds }),
  });
  return asset;
}

export async function createVariantFixture(input: {
  assetId: string;
  hook?: string;
  caption?: string;
  cta?: string;
  hashtags?: string[];
}) {
  return prisma.contentVariant.create({
    data: {
      assetId: input.assetId,
      label: "Fixture",
      hook: input.hook ?? "A plain hook.",
      caption: input.caption ?? "A plain caption that is long enough to score.",
      cta: input.cta ?? "Link in bio",
      hashtags: input.hashtags ?? ["#testing"],
      scorecard: {
        hook: 8,
        clarity: 9,
        curiosity: 8,
        cta: 8,
        trendRelevance: 9,
        notes: [],
      },
    },
  });
}
