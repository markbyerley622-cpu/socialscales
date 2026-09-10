import "../src/lib/load-env";
import { env } from "../src/env";
import { prisma } from "../src/server/db";
import { hashPassword } from "../src/server/security/crypto";
import { createAsset, analyzeAsset } from "../src/server/services/content-service";
import { syncAnalytics } from "../src/server/analytics/snapshots";
import { refreshRecommendations } from "../src/server/learning/recommendations";
import { refreshTrends } from "../src/server/learning/trends";
import { getAiProvider } from "../src/server/ai";
import { closeQueues, queues } from "../src/server/jobs/queues";
import { buildBrandContext } from "../src/server/services/brand-context";
import { ingestAllKnowledge } from "../src/server/knowledge";
import { buildSampleMp4, buildSamplePng, hexToRgb } from "./sample-media";
import { SEED_EXPERIMENTS, SEED_PROJECTS, type SeedHook } from "./seed-data";
import {
  AccountStatus,
  ActorType,
  ApprovalState,

  AttemptOutcome,
  ExperimentRole,
  ExperimentStatus,
  JobStatus,
  PostPlatformStatus,
  PostStatus,
} from "../src/generated/prisma/enums";

/**
 * Seeds a believable working install: three projects, real media files, real
 * analysis, and roughly seven weeks of publishing history so the analytics and
 * learning screens have something genuine to compute over.
 *
 * Deterministic: a fixed PRNG means re-seeding produces the same database, which
 * keeps the test suite and any screenshots stable.
 *
 * What is honest about it, and what is not:
 *  - Media files are structurally real; their video payload is filler bytes.
 *  - Analytics come from the publish simulator and every snapshot is stamped
 *    SIMULATED, so the UI never presents them as platform data.
 *  - Social accounts are seeded DISCONNECTED, because there is no way to have a
 *    real session without a human signing in.
 */

// A small deterministic PRNG (mulberry32) so the seed is reproducible.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = makeRandom(20260910);

function pick<T>(items: T[]): T {
  return items[Math.floor(random() * items.length)];
}

function daysAgo(days: number, hour: number, minute = 0): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function daysAhead(days: number, hour: number, minute = 0): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, minute, 0, 0);
  return date;
}

const log = (message: string) => console.log(`  ${message}`);

// ---------------------------------------------------------------------------

async function reset(): Promise<void> {
  // TRUNCATE ... CASCADE is far faster than cascading deletes through Prisma and
  // resets everything in one statement.
  const tables = [
    "RecommendationEvidence", "StrategyEvidence", "LearningEvidence",
    "StrategyVersion", "Learning", "EvidenceSource",
    "AudienceSegment", "BusinessObjective", "Workspace",
    "ActivityLog", "Recommendation", "ExperimentVariant", "Experiment", "Trend",
    "AnalyticsSnapshot", "PublishAttempt", "PublishJob", "PostPlatform", "Post",
    "ContentVariant", "AIAnalysis", "ContentAsset", "ScheduleSlot", "Schedule",
    "PlatformSession", "SocialAccount", "Hashtag", "ContentPillar", "Brand",
    "Project", "UserSession", "User",
  ];
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map((table) => `"${table}"`).join(", ")} CASCADE;`,
  );

  // Redis holds jobs pointing at rows that no longer exist. The runner already
  // skips those safely, but leaving them makes the worker log noisy and the
  // queue counts meaningless, so clear this app's own queues too. Scoped to our
  // queues by name — a shared Redis keeps everything else.
  try {
    await Promise.all(
      Object.values(queues).map((queue) => queue().obliterate({ force: true })),
    );
  } catch {
    console.log("  (Redis not reachable; skipped clearing the job queues)");
  }
}

async function seedOperator(): Promise<string> {
  if (!env.operator.password) {
    throw new Error(
      "OPERATOR_PASSWORD is not set. Copy .env.example to .env.local first.",
    );
  }
  const user = await prisma.user.create({
    data: {
      email: env.operator.email.toLowerCase(),
      name: env.operator.name,
      passwordHash: await hashPassword(env.operator.password),
      role: "OWNER",
    },
  });
  log(`operator: ${user.email}`);
  return user.id;
}

// ---------------------------------------------------------------------------

type ProjectContext = {
  id: string;
  slug: string;
  name: string;
  accentColor: string;
  accountIds: string[];
  assetIds: Map<string, string>;
  pillarIds: Map<string, string>;
};

async function seedProjects(operatorId: string): Promise<ProjectContext[]> {
  const contexts: ProjectContext[] = [];

  // Every brand lives in a workspace. One is enough for a single-operator install.
  const workspace = await prisma.workspace.create({
    data: { slug: "default", name: "Default workspace" },
  });
  log(`workspace: ${workspace.slug}`);

  for (const spec of SEED_PROJECTS) {
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        slug: spec.slug,
        name: spec.name,
        description: spec.description,
        accentColor: spec.accentColor,
        timezone: spec.timezone,
        publishPolicy: spec.publishPolicy,
        brand: { create: spec.brand },
        pillars: { create: spec.pillars },
        hashtags: {
          create: spec.hashtags.map((tag, index) => ({
            tag,
            usageCount: spec.hashtags.length - index,
          })),
        },
        accounts: {
          // DISCONNECTED is the truth: a real session needs a human to sign in.
          create: spec.accounts.map((account) => ({
            ...account,
            status: AccountStatus.DISCONNECTED,
          })),
        },
        schedules: {
          create: {
            name: "Default cadence",
            timezone: spec.timezone,
            isDefault: true,
            slots: {
              create: spec.slots.map((slot) => ({
                dayOfWeek: slot.dayOfWeek,
                minuteOfDay: slot.hour * 60 + slot.minute,
              })),
            },
          },
        },
      },
      include: { accounts: true, pillars: true },
    });

    const pillarIds = new Map(
      project.pillars.map((pillar) => [pillar.slug, pillar.id]),
    );

    // --- Media -------------------------------------------------------------
    const assetIds = new Map<string, string>();
    for (const assetSpec of spec.assets) {
      const isImage = assetSpec.filename.endsWith(".png");
      const data = isImage
        ? buildSamplePng({
            width: assetSpec.width,
            height: assetSpec.height,
            color: hexToRgb(spec.accentColor),
          })
        : buildSampleMp4({
            durationSeconds: assetSpec.durationSeconds,
            width: assetSpec.width,
            height: assetSpec.height,
            hasAudio: assetSpec.hasAudio,
            // Keep the seed fast; still varies believably per asset.
            payloadBytes: Math.round(assetSpec.durationSeconds * 24_000) + 4_096,
          });

      const { asset } = await createAsset({
        projectId: project.id,
        uploaderId: operatorId,
        filename: assetSpec.filename,
        declaredMime: isImage ? "image/png" : "video/mp4",
        data,
        title: assetSpec.title,
        pillarId: pillarIds.get(assetSpec.pillarSlug) ?? null,
      });
      // Every upload gets analysed, exactly as it would in the running app. This
      // is what gives the format dimension enough observations to learn from.
      await analyzeAsset({ assetId: asset.id, userId: operatorId, variantCount: 3 });
      assetIds.set(assetSpec.filename, asset.id);
    }

    contexts.push({
      id: project.id,
      slug: project.slug,
      name: project.name,
      accentColor: project.accentColor,
      accountIds: project.accounts.map((account) => account.id),
      assetIds,
      pillarIds,
    });

    log(
      `${spec.name}: ${spec.assets.length} assets, ${spec.accounts.length} accounts, ${spec.slots.length} slots`,
    );
  }

  return contexts;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Creates a variant for a hook, scored by the real heuristic provider so the
 * scorecards in the UI are genuine output rather than made-up numbers.
 */
async function createSeedVariant(input: {
  assetId: string;
  projectId: string;
  operatorId: string;
  hook: SeedHook;
  hashtags: string[];
  isControl: boolean;
}): Promise<string> {
  const brand = await buildBrandContext(input.projectId);
  const provider = getAiProvider();
  const suggestion = {
    label: input.hook.label,
    hook: input.hook.hook,
    caption: input.hook.caption,
    hashtags: input.hashtags,
    cta: input.hook.cta,
  };
  const scorecard = provider.scoreCopy({
    suggestion,
    brand,
    analysis: {
      format: "UNKNOWN",
      topic: null,
      likelyAudience: null,
      visualSummary: null,
      transcript: null,
      raw: {},
    },
  });

  const variant = await prisma.contentVariant.create({
    data: {
      assetId: input.assetId,
      createdById: input.operatorId,
      label: input.hook.label,
      hook: input.hook.hook,
      caption: input.hook.caption,
      hashtags: input.hashtags,
      cta: input.hook.cta,
      isControl: input.isControl,
      scorecard: scorecard as unknown as object,
    },
  });
  return variant.id;
}

const PUBLISH_STEPS = [
  "Browser launched",
  "Restored stored session",
  "Account authenticated",
  "Composer opened",
  "Media uploaded",
  "Caption entered",
  "Metadata applied",
  "Publish confirmed",
];

/** A published post with its job, attempt log and per-platform rows. */
async function seedPublishedPost(input: {
  project: ProjectContext;
  assetId: string;
  variantId: string;
  publishedAt: Date;
  accountIds: string[];
  operatorId: string;
  experimentId?: string | null;
}): Promise<void> {
  const accounts = await prisma.socialAccount.findMany({
    where: { id: { in: input.accountIds } },
  });

  const post = await prisma.post.create({
    data: {
      projectId: input.project.id,
      assetId: input.assetId,
      variantId: input.variantId,
      experimentId: input.experimentId ?? null,
      status: PostStatus.PUBLISHED,
      approvalState: ApprovalState.APPROVED,
      approvedById: input.operatorId,
      approvedAt: new Date(input.publishedAt.getTime() - 60 * 60 * 1000),
      scheduledFor: input.publishedAt,
      createdAt: new Date(input.publishedAt.getTime() - 26 * 60 * 60 * 1000),
      targets: {
        create: accounts.map((account) => ({
          socialAccountId: account.id,
          platform: account.platform,
          status: PostPlatformStatus.PUBLISHED,
          publishedAt: input.publishedAt,
          remotePostId: `sim_${account.platform.toLowerCase()}_${Math.floor(random() * 1e12).toString(36)}`,
          permalink: null,
        })),
      },
    },
    include: { targets: true },
  });

  for (const target of post.targets) {
    const job = await prisma.publishJob.create({
      data: {
        postPlatformId: target.id,
        idempotencyKey: `publish:${target.id}`,
        status: JobStatus.SUCCEEDED,
        attempts: 1,
        runAt: input.publishedAt,
        startedAt: input.publishedAt,
        finishedAt: new Date(input.publishedAt.getTime() + 24_000),
      },
    });
    await prisma.publishAttempt.create({
      data: {
        jobId: job.id,
        attemptNo: 1,
        outcome: AttemptOutcome.SUCCESS,
        startedAt: input.publishedAt,
        finishedAt: new Date(input.publishedAt.getTime() + 24_000),
        steps: PUBLISH_STEPS.map((message, index) => ({
          at: new Date(input.publishedAt.getTime() + index * 3_000).toISOString(),
          message,
        })),
      },
    });
  }

  await prisma.activityLog.create({
    data: {
      projectId: input.project.id,
      actorType: ActorType.WORKER,
      action: "publish.succeeded",
      message: `Published to ${accounts.map((a) => a.platform).join(", ")}`,
      entityType: "Post",
      entityId: post.id,
      createdAt: new Date(input.publishedAt.getTime() + 25_000),
    },
  });
}

async function seedHistory(
  projects: ProjectContext[],
  operatorId: string,
): Promise<number> {
  let published = 0;

  for (const project of projects) {
    const spec = SEED_PROJECTS.find((entry) => entry.slug === project.slug)!;
    const videoAssets = spec.assets.filter((asset) => !asset.filename.endsWith(".png"));
    const accountIds = project.accountIds;

    // ~7 weeks of history at roughly 3 posts a week, cycling hook patterns and
    // posting windows so every learning dimension has multiple observations.
    let index = 0;
    for (let dayOffset = 48; dayOffset >= 4; dayOffset -= 2) {
      const assetSpec = videoAssets[index % videoAssets.length];
      const hook = spec.hooks[index % spec.hooks.length];
      const slot = spec.slots[index % spec.slots.length];

      const assetId = project.assetIds.get(assetSpec.filename)!;
      const variantId = await createSeedVariant({
        assetId,
        projectId: project.id,
        operatorId,
        hook,
        hashtags: spec.hashtags.slice(0, 4 + (index % 3)),
        isControl: index === 0,
      });

      // One or two destinations per post, so per-platform data exists.
      const destinations =
        index % 3 === 0 ? accountIds : accountIds.slice(0, Math.max(1, accountIds.length - 1));

      await seedPublishedPost({
        project,
        assetId,
        variantId,
        publishedAt: daysAgo(dayOffset, slot.hour, slot.minute),
        accountIds: destinations,
        operatorId,
      });

      published += destinations.length;
      index += 1;
    }

    log(`${project.name}: ${index} published posts across ${accountIds.length} accounts`);
  }

  return published;
}

// ---------------------------------------------------------------------------
// Live pipeline state: things waiting for a human right now
// ---------------------------------------------------------------------------

async function seedPipeline(
  projects: ProjectContext[],
  operatorId: string,
): Promise<void> {
  for (const project of projects) {
    const spec = SEED_PROJECTS.find((entry) => entry.slug === project.slug)!;
    const assetEntries = [...project.assetIds.entries()];

    // Two assets sit awaiting review on their AI-suggested copy.
    for (const [filename, assetId] of assetEntries.slice(0, 2)) {
      const suggested = await prisma.contentVariant.findFirstOrThrow({
        where: { assetId, createdById: operatorId },
        orderBy: { createdAt: "asc" },
      });
      const variantId = suggested.id;

      await prisma.post.create({
        data: {
          projectId: project.id,
          assetId,
          variantId,
          status: PostStatus.READY,
          approvalState: ApprovalState.PENDING,
          scheduledFor: daysAhead(1 + assetEntries.indexOf([filename, assetId]), 19, 0),
          targets: {
            create: project.accountIds.slice(0, 2).map((accountId, position) => ({
              socialAccountId: accountId,
              platform: spec.accounts[position].platform,
              status: PostPlatformStatus.PENDING,
            })),
          },
        },
      });
    }

    // Approved and scheduled, waiting for its slot.
    for (let ahead = 1; ahead <= 3; ahead += 1) {
      const assetSpec = pick(spec.assets.filter((a) => !a.filename.endsWith(".png")));
      const hook = spec.hooks[(ahead + 2) % spec.hooks.length];
      const assetId = project.assetIds.get(assetSpec.filename)!;
      const variantId = await createSeedVariant({
        assetId,
        projectId: project.id,
        operatorId,
        hook,
        hashtags: spec.hashtags.slice(0, 5),
        isControl: false,
      });
      const slot = spec.slots[ahead % spec.slots.length];
      const scheduledFor = daysAhead(ahead, slot.hour, slot.minute);

      const post = await prisma.post.create({
        data: {
          projectId: project.id,
          assetId,
          variantId,
          status: PostStatus.SCHEDULED,
          approvalState: ApprovalState.APPROVED,
          approvedById: operatorId,
          approvedAt: new Date(),
          scheduledFor,
          targets: {
            create: project.accountIds.slice(0, 2).map((accountId, position) => ({
              socialAccountId: accountId,
              platform: spec.accounts[position].platform,
              status: PostPlatformStatus.QUEUED,
            })),
          },
        },
        include: { targets: true },
      });

      for (const target of post.targets) {
        await prisma.publishJob.create({
          data: {
            postPlatformId: target.id,
            idempotencyKey: `publish:${target.id}`,
            status: JobStatus.PENDING,
            runAt: scheduledFor,
          },
        });
      }
    }

    // One failed job per project, with a real error and an attempt log, so the
    // failure path in the UI is populated rather than theoretical.
    const failedAssetSpec = spec.assets.find((a) => !a.filename.endsWith(".png"))!;
    const failedAssetId = project.assetIds.get(failedAssetSpec.filename)!;
    const failedVariantId = await createSeedVariant({
      assetId: failedAssetId,
      projectId: project.id,
      operatorId,
      hook: spec.hooks[1],
      hashtags: spec.hashtags.slice(0, 3),
      isControl: false,
    });
    const failedAt = daysAgo(1, 19, 30);
    const failedPost = await prisma.post.create({
      data: {
        projectId: project.id,
        assetId: failedAssetId,
        variantId: failedVariantId,
        status: PostStatus.FAILED,
        approvalState: ApprovalState.APPROVED,
        approvedById: operatorId,
        approvedAt: failedAt,
        scheduledFor: failedAt,
        targets: {
          create: [
            {
              socialAccountId: project.accountIds[0],
              platform: spec.accounts[0].platform,
              status: PostPlatformStatus.FAILED,
              lastError:
                "Simulated transient publish failure (composer confirmation timed out). This is the retry path, not a real platform error.",
            },
          ],
        },
      },
      include: { targets: true },
    });

    const failedTarget = failedPost.targets[0];
    const failedJob = await prisma.publishJob.create({
      data: {
        postPlatformId: failedTarget.id,
        idempotencyKey: `publish:${failedTarget.id}`,
        status: JobStatus.FAILED,
        attempts: 1,
        maxAttempts: 3,
        runAt: failedAt,
        startedAt: failedAt,
        lastError:
          "Simulated transient publish failure (composer confirmation timed out). This is the retry path, not a real platform error.",
      },
    });
    await prisma.publishAttempt.create({
      data: {
        jobId: failedJob.id,
        attemptNo: 1,
        outcome: AttemptOutcome.RETRYABLE_FAILURE,
        startedAt: failedAt,
        finishedAt: new Date(failedAt.getTime() + 41_000),
        errorMessage:
          "Simulated transient publish failure (composer confirmation timed out).",
        steps: PUBLISH_STEPS.slice(0, 6).map((message, index) => ({
          at: new Date(failedAt.getTime() + index * 4_000).toISOString(),
          message,
        })),
      },
    });
  }

  log("pipeline: pending approvals, scheduled posts and one failed job per project");
}

// ---------------------------------------------------------------------------

async function seedExperiments(projects: ProjectContext[]): Promise<void> {
  for (const spec of SEED_EXPERIMENTS) {
    const project = projects.find((entry) => entry.slug === spec.projectSlug);
    if (!project) continue;

    const projectSpec = SEED_PROJECTS.find((entry) => entry.slug === spec.projectSlug)!;
    const controlHook = projectSpec.hooks.find((hook) => hook.pattern === spec.controlPattern);
    const variantHook = projectSpec.hooks.find((hook) => hook.pattern === spec.variantPattern);
    if (!controlHook || !variantHook) continue;

    // Attach to existing variants that already carry those hooks, so the
    // experiment measures posts that genuinely went out.
    const [control, variant] = await Promise.all([
      prisma.contentVariant.findFirst({
        where: { hook: controlHook.hook, asset: { projectId: project.id } },
      }),
      prisma.contentVariant.findFirst({
        where: { hook: variantHook.hook, asset: { projectId: project.id } },
      }),
    ]);
    if (!control || !variant) continue;

    await prisma.experiment.create({
      data: {
        projectId: project.id,
        name: spec.name,
        hypothesis: spec.hypothesis,
        metric: spec.metric,
        status: ExperimentStatus.RUNNING,
        startedAt: daysAgo(21, 9),
        variants: {
          create: [
            { variantId: control.id, role: ExperimentRole.CONTROL },
            { variantId: variant.id, role: ExperimentRole.VARIANT },
          ],
        },
      },
    });
  }
  log(`experiments: ${SEED_EXPERIMENTS.length} running hook tests`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\nSeeding CONTENT OS\n");

  await reset();
  const operatorId = await seedOperator();
  const projects = await seedProjects(operatorId);
  const publishedTargets = await seedHistory(projects, operatorId);
  await seedPipeline(projects, operatorId);
  await seedExperiments(projects);

  // Global priors: the cold-start knowledge every workspace starts with. Stored
  // as GLOBAL_PRIOR evidence, so they can inform planning but can never be
  // mistaken for something these brands demonstrated.
  const workspaceId = (
    await prisma.workspace.findFirstOrThrow({ where: { slug: "default" } })
  ).id;
  const ingested = await ingestAllKnowledge({ workspaceId });
  log(
    `priors: ${ingested.reduce((sum, r) => sum + r.written, 0)} global prior(s) from ${ingested.length} provider(s)`,
  );

  // Real snapshot capture through the real code path, honouring age buckets.
  log("capturing analytics snapshots through the normal sync path...");
  const summary = await syncAnalytics();
  log(
    `analytics: ${summary.snapshotsCreated} snapshots over ${summary.postsChecked} published destinations (source: SIMULATED)`,
  );

  for (const project of projects) {
    const trends = await refreshTrends(project.id);
    const recommendations = await refreshRecommendations(project.id);
    log(
      `${project.name}: ${trends} trend observations, ${recommendations.created} recommendations`,
    );
  }

  const [assets, variants, posts, snapshots] = await Promise.all([
    prisma.contentAsset.count(),
    prisma.contentVariant.count(),
    prisma.post.count(),
    prisma.analyticsSnapshot.count(),
  ]);

  console.log(`
Seed complete.

  projects           ${projects.length}
  assets             ${assets}
  copy variants      ${variants}
  posts              ${posts}
  published targets  ${publishedTargets}
  snapshots          ${snapshots}

  Sign in at http://localhost:3000 with ${env.operator.email}
  The password is OPERATOR_PASSWORD in .env.local.

  Social accounts are DISCONNECTED: connect one from the Accounts page to
  enable live publishing. Until then the worker uses the publish simulator and
  every metric is labelled SIMULATED.
`);

  await prisma.$disconnect();
  await closeQueues().catch(() => {});
}

main().catch(async (error) => {
  console.error("\nSeed failed:\n", error);
  await prisma.$disconnect();
  process.exit(1);
});
