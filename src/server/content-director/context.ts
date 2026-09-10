import { prisma } from "@/server/db";
import { StrategyStatus } from "@/generated/prisma/enums";

/**
 * Everything the content director may plan from.
 *
 * A plan implements exactly one strategy version, and the version is captured
 * here so the plan can never drift onto a newer strategy halfway through. The
 * cadence source is stated explicitly — a plan built from the project's real
 * schedule slots and one built from the strategy's guessed cadence are different
 * things, and the difference should be readable later.
 */

export type PlanWindow = {
  /** Local ISO dates, inclusive of the start. */
  startsOn: string;
  endsOn: string;
  timezone: string;
  days: number;
  /** How many publish slots the window actually contains. */
  slotCount: number;
  /** How many briefs to write. */
  briefTarget: number;
  /** "schedule slots" or "strategy cadence" — never silently conflated. */
  cadenceSource: string;
};

export type PlanStrategy = {
  id: string;
  version: number;
  confidence: string;
  summary: string;
  hookFamilies: string[];
  recommendedFormats: string[];
  narrativeStructures: string[];
  contentPillars: string[];
  ctaStrategy: string | null;
  targetAudienceId: string | null;
  targetAudienceName: string | null;
  cadence: { postsPerWeek: number; notes: string };
  hypotheses: Array<{
    claim: string;
    dimension: string;
    howToTest: string;
    basedOn: string[];
  }>;
};

export type PlanContext = {
  projectId: string;
  projectName: string;
  brand: {
    audience: string;
    tone: string;
    valueProp: string;
    primaryCta: string;
    prohibitedTopics: string[];
    bannedPhrases: string[];
  };
  strategy: PlanStrategy;
  pillars: Array<{ slug: string; name: string; description: string | null }>;
  objectiveKpis: string[];
  platforms: string[];
  window: PlanWindow;
  /** Angles already used, so a plan does not re-commission the same piece. */
  recentAngles: string[];
};

export class NoActiveStrategyError extends Error {
  constructor(projectName: string) {
    super(
      `${projectName} has no active strategy. A content plan implements a strategy, so draft and activate one first.`,
    );
    this.name = "NoActiveStrategyError";
  }
}

export async function buildPlanContext(input: {
  projectId: string;
  /** Local date the window opens. Defaults to today. */
  startsOn?: Date;
  days?: number;
  /** Overrides the computed brief count. */
  briefTarget?: number;
}): Promise<PlanContext> {
  const days = input.days ?? 14;
  const startsOn = startOfDay(input.startsOn ?? new Date());
  const endsOn = new Date(startsOn.getTime() + (days - 1) * 86_400_000);

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: input.projectId },
    include: {
      brand: true,
      pillars: { orderBy: { name: "asc" } },
      objectives: { where: { active: true }, orderBy: { priority: "asc" } },
      accounts: true,
      schedules: { include: { slots: true } },
    },
  });

  const strategy = await prisma.strategyVersion.findFirst({
    where: { projectId: input.projectId, status: StrategyStatus.ACTIVE },
    orderBy: { version: "desc" },
    include: { targetAudience: true },
  });
  if (!strategy) throw new NoActiveStrategyError(project.name);

  const cadence = readCadence(strategy.cadence);
  const schedule =
    project.schedules.find((entry) => entry.isDefault) ?? project.schedules[0] ?? null;
  const slotsPerWeek = schedule?.slots.length ?? 0;

  // Real slots beat a guessed cadence, and the plan records which it used.
  const cadenceSource =
    slotsPerWeek > 0 ? "from this project's schedule slots" : "from the strategy's cadence";
  const perWeek = slotsPerWeek > 0 ? slotsPerWeek : cadence.postsPerWeek;
  const slotCount = Math.max(1, Math.round((perWeek * days) / 7));
  const briefTarget = Math.min(40, input.briefTarget ?? slotCount);

  const recentAngles = await recentlyUsedAngles(input.projectId);

  return {
    projectId: project.id,
    projectName: project.name,
    brand: {
      audience: project.brand?.audience ?? "not stated",
      tone: project.brand?.tone ?? "not stated",
      valueProp: project.brand?.valueProp ?? "not stated",
      primaryCta: project.brand?.primaryCta ?? "not stated",
      prohibitedTopics: project.brand?.prohibitedTopics ?? [],
      bannedPhrases: project.brand?.bannedPhrases ?? [],
    },
    strategy: {
      id: strategy.id,
      version: strategy.version,
      confidence: strategy.confidence,
      summary: strategy.summary,
      hookFamilies: strategy.hookFamilies,
      recommendedFormats: strategy.recommendedFormats,
      narrativeStructures: strategy.narrativeStructures,
      contentPillars: strategy.contentPillars,
      ctaStrategy: strategy.ctaStrategy,
      targetAudienceId: strategy.targetAudienceId,
      targetAudienceName: strategy.targetAudience?.name ?? null,
      cadence,
      hypotheses: readHypotheses(strategy.hypotheses),
    },
    pillars: project.pillars.map((pillar) => ({
      slug: pillar.slug,
      name: pillar.name,
      description: pillar.description,
    })),
    objectiveKpis: project.objectives.map((objective) => objective.kpi),
    platforms: [
      ...new Set(
        project.accounts
          .filter((account) => account.status === "CONNECTED")
          .map((account) => account.platform),
      ),
    ],
    window: {
      startsOn: isoDate(startsOn),
      endsOn: isoDate(endsOn),
      timezone: project.timezone,
      days,
      slotCount,
      briefTarget,
      cadenceSource,
    },
    recentAngles,
  };
}

/**
 * Publish times for a window.
 *
 * Uses the project's real schedule slots where it has them, so a plan lands on
 * the times the operator already chose. Where it does not, it spreads evenly
 * across the window rather than inventing a posting time it cannot justify — an
 * arbitrary "best time to post" is exactly the kind of unfounded claim this
 * system is not allowed to make.
 */
export async function planSlots(input: {
  projectId: string;
  startsOn: Date;
  days: number;
  count: number;
}): Promise<Date[]> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: input.projectId },
    include: { schedules: { include: { slots: true } } },
  });
  const schedule =
    project.schedules.find((entry) => entry.isDefault) ?? project.schedules[0] ?? null;

  const start = startOfDay(input.startsOn);
  const times: Date[] = [];

  if (schedule && schedule.slots.length > 0) {
    const slots = [...schedule.slots].sort(
      (a, b) => a.dayOfWeek - b.dayOfWeek || a.minuteOfDay - b.minuteOfDay,
    );
    for (let dayOffset = 0; dayOffset < input.days && times.length < input.count; dayOffset += 1) {
      const day = new Date(start.getTime() + dayOffset * 86_400_000);
      for (const slot of slots) {
        if (times.length >= input.count) break;
        if (slot.dayOfWeek !== day.getDay()) continue;
        times.push(new Date(day.getTime() + slot.minuteOfDay * 60_000));
      }
    }
    if (times.length >= input.count) return times.slice(0, input.count);
  }

  // Even spread, at a neutral mid-morning hour. Not a recommendation — just a
  // placeholder the operator can move, and the plan's rationale says so.
  const spacingMs = Math.max(1, Math.floor((input.days * 86_400_000) / input.count));
  for (let index = times.length; index < input.count; index += 1) {
    const at = new Date(start.getTime() + index * spacingMs);
    at.setHours(10, 0, 0, 0);
    times.push(at);
  }
  return times.slice(0, input.count);
}

async function recentlyUsedAngles(projectId: string): Promise<string[]> {
  const briefs = await prisma.contentBrief.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: { workingTitle: true },
  });
  return briefs.map((brief) => brief.workingTitle);
}

export function readCadence(value: unknown): { postsPerWeek: number; notes: string } {
  const cadence = value as { postsPerWeek?: unknown; notes?: unknown } | null;
  const perWeek =
    typeof cadence?.postsPerWeek === "number" && cadence.postsPerWeek > 0
      ? Math.min(35, Math.round(cadence.postsPerWeek))
      : 3;
  return {
    postsPerWeek: perWeek,
    notes: typeof cadence?.notes === "string" ? cadence.notes : "",
  };
}

export function readHypotheses(value: unknown): PlanStrategy["hypotheses"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.claim !== "string" || typeof row.howToTest !== "string") return [];
    return [
      {
        claim: row.claim,
        dimension: typeof row.dimension === "string" ? row.dimension : "unknown",
        howToTest: row.howToTest,
        basedOn: Array.isArray(row.basedOn)
          ? row.basedOn.filter((id): id is string => typeof id === "string")
          : [],
      },
    ];
  });
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
