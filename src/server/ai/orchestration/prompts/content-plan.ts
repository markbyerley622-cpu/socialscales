import { z } from "zod";
import { AIOperation, ContentFormat } from "@/generated/prisma/enums";
import type { PlanContext } from "@/server/content-director/context";
import { registerPrompt } from "../registry";

/**
 * Turns an active strategy into a list of concrete briefs.
 *
 * The distinction this prompt exists to hold: a strategy says "lean on numeric
 * hooks and screen recordings"; a brief says "show the CSV import failing on a
 * real file, open on the error, 25 seconds". A plan made of restated strategy is
 * not a plan, so `refine` rejects briefs whose angle is a paraphrase of their
 * own strategy basis.
 *
 * Every brief carries the strategy decision it serves. That is what makes a
 * published post traceable back through the plan to the evidence.
 */

export type ContentPlanInput = PlanContext;

const briefSchema = z.object({
  workingTitle: z.string().min(4).max(120),
  /** The specific idea. Not the category. */
  angle: z.string().min(20).max(500),
  keyMessage: z.string().min(10).max(300),
  pillarSlug: z.string().max(80).nullable(),
  format: z.enum(Object.values(ContentFormat) as [string, ...string[]]),
  hookFamily: z.string().max(60).nullable(),
  minSeconds: z.number().int().min(3).max(600).nullable(),
  maxSeconds: z.number().int().min(3).max(600).nullable(),
  objectiveKpi: z.string().max(80).nullable(),
  productionNotes: z.string().max(1_200).nullable(),
  /** Which strategy decision this serves, e.g. "hookFamilies: numeric". */
  strategyBasis: z.string().min(4).max(200),
  /** True when the piece exists to test a hypothesis rather than to perform. */
  isExperiment: z.boolean(),
  /** Index into the strategy's hypotheses array. Required when isExperiment. */
  hypothesisIndex: z.number().int().min(0).max(20).nullable(),
});

export const contentPlanSchema = z.object({
  summary: z.string().min(30).max(1_000),
  briefs: z.array(briefSchema).min(1).max(40),
  /** Honest notes on what the plan could not cover and why. */
  gaps: z.array(z.string().min(10).max(300)).max(6),
});

export type ContentPlanOutput = z.infer<typeof contentPlanSchema>;
export type PlannedBrief = z.infer<typeof briefSchema>;

const SYSTEM = [
  "You turn a content strategy into a list of specific, makeable briefs.",
  "",
  "A brief is not a restatement of the strategy. The strategy says which hook",
  "family; the brief says what actually happens on screen. If a brief could be",
  "produced without reading it, it is not a brief.",
  "",
  "Rules:",
  "- Every brief names the strategy decision it serves in `strategyBasis`, using",
  "  a decision the supplied strategy actually made.",
  "- `angle` describes the specific thing shown or said. Not a topic, not a",
  "  category, not the strategy repeated.",
  "- Use the supplied pillars, formats, hook families and objective KPIs. Do not",
  "  invent new ones.",
  "- At least one brief per strategy hypothesis that can be tested with content,",
  "  marked isExperiment with its hypothesisIndex.",
  "- Respect prohibited topics and banned phrases.",
  "- Do not predict performance. You have never seen this audience.",
  "- Name what you could not cover in `gaps` rather than padding the plan.",
  "",
  "Return JSON only. No prose, no code fences.",
].join("\n");

function renderUser(context: PlanContext): string {
  const lines: string[] = [];
  const { strategy } = context;

  lines.push("## Brand");
  lines.push(`name: ${context.projectName}`);
  lines.push(`audience: ${context.brand.audience}`);
  lines.push(`tone: ${context.brand.tone}`);
  lines.push(`valueProp: ${context.brand.valueProp}`);
  lines.push(`primaryCta: ${context.brand.primaryCta}`);
  lines.push(`prohibitedTopics: ${context.brand.prohibitedTopics.join("; ") || "none"}`);
  lines.push(`bannedPhrases: ${context.brand.bannedPhrases.join("; ") || "none"}`);

  lines.push("", `## Strategy v${strategy.version} (confidence ${strategy.confidence})`);
  lines.push(strategy.summary);
  lines.push(`hookFamilies: ${strategy.hookFamilies.join(", ") || "none"}`);
  lines.push(`recommendedFormats: ${strategy.recommendedFormats.join(", ") || "none"}`);
  lines.push(`narrativeStructures: ${strategy.narrativeStructures.join(", ") || "none"}`);
  lines.push(`ctaStrategy: ${strategy.ctaStrategy ?? "none"}`);
  lines.push(`targetAudience: ${strategy.targetAudienceName ?? "not narrowed"}`);

  lines.push("", "### Hypotheses (index: claim)");
  if (strategy.hypotheses.length === 0) lines.push("none");
  strategy.hypotheses.forEach((hypothesis, index) => {
    lines.push(
      `${index}: ${hypothesis.claim} — how to test: ${hypothesis.howToTest}${
        hypothesis.basedOn.length === 0 ? " [UNTESTED GUESS]" : ""
      }`,
    );
  });

  lines.push("", "## Available pillars");
  lines.push(
    context.pillars
      .map((pillar) => `- ${pillar.slug}: ${pillar.name}${pillar.description ? ` — ${pillar.description}` : ""}`)
      .join("\n") || "none defined",
  );

  lines.push("", "## Objective KPIs");
  lines.push(context.objectiveKpis.join(", ") || "none defined");

  lines.push("", "## The window");
  lines.push(
    `${context.window.startsOn} to ${context.window.endsOn} (${context.window.timezone}), ${context.window.days} days`,
  );
  lines.push(
    `slots available: ${context.window.slotCount} (${context.window.cadenceSource})`,
  );
  lines.push(`briefs wanted: ${context.window.briefTarget}`);
  lines.push(`platforms: ${context.platforms.join(", ") || "none connected"}`);

  if (context.recentAngles.length > 0) {
    lines.push("", "## Already published or planned recently — do not repeat these");
    for (const angle of context.recentAngles) lines.push(`- ${angle}`);
  }

  lines.push("", `Allowed format values: ${Object.values(ContentFormat).join(", ")}`);
  lines.push(
    "",
    `Write exactly ${context.window.briefTarget} briefs. Each one specific enough to shoot from.`,
  );
  return lines.join("\n");
}

export const contentPlanPrompt = registerPrompt<ContentPlanInput, ContentPlanOutput>({
  name: "content-plan",
  version: "1.0.0",
  operation: AIOperation.CONTENT_PLAN,
  description:
    "Turns an active strategy into a window of specific content briefs, each naming the strategy decision it serves.",
  schema: contentPlanSchema,
  maxOutputTokens: 6_000,

  render(context) {
    return { system: SYSTEM, user: renderUser(context) };
  },

  /**
   * The rule-based plan: rotate the strategy's hook families across its formats
   * and the project's pillars, so the window covers the strategy's choices
   * evenly rather than over-indexing on whichever was listed first, and turn
   * each testable hypothesis into an explicit experiment brief.
   *
   * Its angles are honest about what they are: a template naming the pillar and
   * the hook family. It says so, rather than dressing a rotation up as an idea.
   */
  deterministic(context) {
    const { strategy } = context;
    const hooks = strategy.hookFamilies.length > 0 ? strategy.hookFamilies : ["direct"];
    const formats =
      strategy.recommendedFormats.length > 0
        ? strategy.recommendedFormats
        : [ContentFormat.TALKING_HEAD];
    const pillars =
      context.pillars.length > 0
        ? context.pillars
        : [{ slug: "general", name: "General", description: null }];
    const kpi = context.objectiveKpis[0] ?? null;

    const target = context.window.briefTarget;
    const briefs: PlannedBrief[] = [];

    // Experiment briefs first: a hypothesis nobody makes content for never gets
    // tested, and the plan is where that either happens or visibly does not.
    strategy.hypotheses.forEach((hypothesis, index) => {
      if (briefs.length >= target) return;
      const pillar = pillars[index % pillars.length]!;
      const hook = hooks[index % hooks.length]!;
      briefs.push({
        workingTitle: `Test: ${truncate(hypothesis.claim, 80)}`,
        angle: `A deliberate test of the strategy's hypothesis "${truncate(hypothesis.claim, 200)}". ${hypothesis.howToTest}`,
        keyMessage: `Whether "${hook}" holds up for ${kpi ?? "the primary objective"} on this account.`,
        pillarSlug: pillar.slug,
        format: formats[index % formats.length]!,
        hookFamily: hook,
        minSeconds: 15,
        maxSeconds: 45,
        objectiveKpi: kpi,
        productionNotes: `Hold everything else constant so the result can be read. ${hypothesis.howToTest}`,
        strategyBasis: `hypotheses.${index}`,
        isExperiment: true,
        hypothesisIndex: index,
      });
    });

    // Then rotate the strategy's own choices across the remaining slots.
    let cursor = 0;
    while (briefs.length < target) {
      const pillar = pillars[cursor % pillars.length]!;
      const hook = hooks[cursor % hooks.length]!;
      const format = formats[cursor % formats.length]!;
      briefs.push({
        workingTitle: `${pillar.name}: ${hook} angle`,
        angle: `Cover ${pillar.name.toLowerCase()} using a ${hook} opening in a ${format.toLowerCase().replace(/_/g, " ")} format. This is a rotation slot, not a specific idea — the operator supplies the specific thing shown.`,
        keyMessage: `${context.brand.valueProp}`,
        pillarSlug: pillar.slug,
        format,
        hookFamily: hook,
        minSeconds: 15,
        maxSeconds: 45,
        objectiveKpi: kpi,
        productionNotes: `Open on the ${hook} beat within the first two seconds. Close with: ${context.brand.primaryCta}`,
        strategyBasis: `hookFamilies: ${hook}`,
        isExperiment: false,
        hypothesisIndex: null,
      });
      cursor += 1;
    }

    const gaps: string[] = [];
    if (context.pillars.length === 0) {
      gaps.push(
        "This project has no content pillars defined, so the plan cannot spread coverage across themes.",
      );
    }
    if (context.objectiveKpis.length === 0) {
      gaps.push(
        "No business objectives are defined, so no brief can say which KPI it is meant to move.",
      );
    }
    if (strategy.hypotheses.length === 0) {
      gaps.push("The strategy proposes no hypotheses, so nothing in this window is a test.");
    }
    gaps.push(
      "These angles are rotations over the strategy's choices, not specific ideas. A person supplies what actually happens on screen.",
    );

    return {
      summary: `${target} briefs across ${context.window.days} days for ${context.projectName}, rotating ${hooks.join("/")} hooks over ${formats.join("/")} formats and ${pillars.length} pillar${pillars.length === 1 ? "" : "s"}, implementing strategy v${strategy.version}.`,
      briefs: briefs.slice(0, target),
      gaps: gaps.slice(0, 6),
    };
  },

  refine(value, context) {
    const problems: string[] = [];
    const { strategy } = context;

    if (value.briefs.length !== context.window.briefTarget) {
      problems.push(
        `briefs: expected exactly ${context.window.briefTarget} briefs for this window, received ${value.briefs.length}.`,
      );
    }

    const pillarSlugs = new Set(context.pillars.map((pillar) => pillar.slug));
    const kpis = new Set(context.objectiveKpis);
    const validFormats = new Set<string>(Object.values(ContentFormat));
    const hookFamilies = new Set(strategy.hookFamilies);

    value.briefs.forEach((brief, index) => {
      if (brief.pillarSlug !== null && pillarSlugs.size > 0 && !pillarSlugs.has(brief.pillarSlug)) {
        problems.push(
          `briefs.${index}.pillarSlug: "${brief.pillarSlug}" is not a pillar of this project (${[...pillarSlugs].join(", ")}).`,
        );
      }
      if (brief.objectiveKpi !== null && kpis.size > 0 && !kpis.has(brief.objectiveKpi)) {
        problems.push(
          `briefs.${index}.objectiveKpi: "${brief.objectiveKpi}" is not an objective of this project (${[...kpis].join(", ")}).`,
        );
      }
      if (!validFormats.has(brief.format)) {
        problems.push(`briefs.${index}.format: "${brief.format}" is not a valid format.`);
      }
      if (
        brief.hookFamily !== null &&
        hookFamilies.size > 0 &&
        !hookFamilies.has(brief.hookFamily)
      ) {
        problems.push(
          `briefs.${index}.hookFamily: "${brief.hookFamily}" is not in the strategy's hook families (${[...hookFamilies].join(", ")}).`,
        );
      }
      if (
        brief.minSeconds !== null &&
        brief.maxSeconds !== null &&
        brief.minSeconds > brief.maxSeconds
      ) {
        problems.push(`briefs.${index}: minSeconds is greater than maxSeconds.`);
      }
      if (brief.isExperiment) {
        if (brief.hypothesisIndex === null) {
          problems.push(
            `briefs.${index}.hypothesisIndex: an experiment brief must say which hypothesis it tests.`,
          );
        } else if (brief.hypothesisIndex >= strategy.hypotheses.length) {
          problems.push(
            `briefs.${index}.hypothesisIndex: ${brief.hypothesisIndex} is beyond the strategy's ${strategy.hypotheses.length} hypotheses.`,
          );
        }
      }
      // A brief whose angle is its own basis restated is not a brief.
      if (normalise(brief.angle) === normalise(brief.strategyBasis)) {
        problems.push(
          `briefs.${index}.angle: this repeats strategyBasis. The angle must say what actually happens on screen.`,
        );
      }
      for (const topic of context.brand.prohibitedTopics) {
        const needle = topic.toLowerCase();
        if (needle !== "" && `${brief.angle} ${brief.keyMessage}`.toLowerCase().includes(needle)) {
          problems.push(`briefs.${index}: mentions the prohibited topic "${topic}".`);
        }
      }
    });

    const titles = value.briefs.map((brief) => normalise(brief.workingTitle));
    if (new Set(titles).size !== titles.length) {
      problems.push("briefs: two briefs share a working title. Each is a separate piece.");
    }

    return problems;
  },
});

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
