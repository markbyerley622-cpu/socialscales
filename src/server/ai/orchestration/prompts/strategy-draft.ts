import { z } from "zod";
import { AIOperation, ContentFormat } from "@/generated/prisma/enums";
import type { StrategyContext } from "@/server/strategy/context";
import { registerPrompt } from "../registry";

/**
 * The content strategy for one brand.
 *
 * The honesty constraints live in `refine`, because they are the ones that
 * actually matter and a schema cannot express them:
 *
 *  - Every hypothesis cites evidence by id, and every id must be one the context
 *    supplied. A model that invents a citation fails validation rather than
 *    producing a plausible-looking lie.
 *  - Audiences, objectives and pillars must be ones this brand actually has.
 *  - Confidence is capped by what the account has observed. A brand with no
 *    published results cannot get a MEDIUM or HIGH strategy however coherent the
 *    priors behind it are.
 */

export type StrategyDraftInput = StrategyContext;

const hypothesisSchema = z.object({
  claim: z.string().min(10).max(300),
  dimension: z.string().min(2).max(40),
  /** How the account would find out, concretely. */
  howToTest: z.string().min(10).max(400),
  /** Evidence ids from the supplied context. Empty means "untested guess". */
  basedOn: z.array(z.string().min(1)).max(12),
});

const riskSchema = z.object({
  risk: z.string().min(10).max(300),
  mitigation: z.string().min(10).max(300),
});

export const strategyDraftSchema = z.object({
  summary: z.string().min(40).max(1_200),
  /** Must name one of the supplied audiences, or null if none fits. */
  targetAudienceName: z.string().max(120).nullable(),
  primaryObjectiveKpi: z.string().max(80).nullable(),
  secondaryObjectiveKpi: z.string().max(80).nullable(),
  contentPillars: z.array(z.string().min(1).max(80)).max(8),
  recommendedFormats: z.array(z.string().min(2).max(40)).min(1).max(6),
  hookFamilies: z.array(z.string().min(2).max(60)).min(1).max(6),
  narrativeStructures: z.array(z.string().min(2).max(60)).max(6),
  ctaStrategy: z.string().max(300).nullable(),
  /** Platform name -> what this strategy does differently there. */
  platformStrategy: z.record(z.string(), z.string().max(400)),
  cadence: z.object({
    postsPerWeek: z.number().int().min(1).max(35),
    notes: z.string().max(400),
  }),
  hypotheses: z.array(hypothesisSchema).min(1).max(8),
  risks: z.array(riskSchema).min(1).max(8),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
});

export type StrategyDraftOutput = z.infer<typeof strategyDraftSchema>;

const SYSTEM = [
  "You write content strategy for one brand, from that brand's own evidence and",
  "from general priors, and you are explicit about which is which.",
  "",
  "Rules:",
  "- Cite evidence by id in `basedOn`. Only ids present in the supplied context",
  "  exist. Never write an id that was not given to you.",
  "- A hypothesis with an empty `basedOn` is an untested guess. That is allowed,",
  "  and it must read like one — do not dress it up as a finding.",
  "- Never claim an option caused an outcome. Evidence from published results is",
  "  associative: it cannot separate the hook from the topic, the day or the",
  "  algorithm. Only a controlled experiment supports a causal claim.",
  "- `targetAudienceName` must exactly match one of the supplied audience names.",
  "  The objective KPIs must exactly match supplied KPIs. Pillars must be",
  "  supplied pillars.",
  "- `recommendedFormats` must be values from the supplied format list.",
  "- confidence reflects the account's evidence, not the coherence of your",
  "  argument. With no observations of this account, confidence is LOW.",
  "- Respect prohibited topics and banned phrases.",
  "- Do not describe your reasoning process. Give the strategy and its basis.",
  "",
  "Return JSON only. No prose, no code fences.",
].join("\n");

function renderUser(context: StrategyContext): string {
  const lines: string[] = [];

  lines.push("## Brand", `name: ${context.projectName}`);
  lines.push(`audience: ${context.brand.audience}`);
  lines.push(`tone: ${context.brand.tone}`);
  lines.push(`valueProp: ${context.brand.valueProp}`);
  lines.push(`primaryCta: ${context.brand.primaryCta}`);
  if (context.brand.industry) lines.push(`industry: ${context.brand.industry}`);
  if (context.brand.geography) lines.push(`geography: ${context.brand.geography}`);
  if (context.brand.differentiators.length > 0) {
    lines.push(`differentiators: ${context.brand.differentiators.join("; ")}`);
  }
  if (context.brand.competitors.length > 0) {
    lines.push(`competitors: ${context.brand.competitors.join(", ")}`);
  }
  lines.push(`prohibitedTopics: ${context.brand.prohibitedTopics.join("; ") || "none"}`);
  lines.push(`bannedPhrases: ${context.brand.bannedPhrases.join("; ") || "none"}`);

  lines.push("", "## Account state");
  lines.push(context.accountState.reason);
  lines.push(
    `published: ${context.accountState.publishedPosts} (${context.accountState.verifiedPublications} confirmed by the platform)`,
  );
  lines.push(`connectedPlatforms: ${context.accountState.connectedPlatforms.join(", ") || "none"}`);
  if (context.accountState.analyticsAreSimulated) {
    lines.push(
      "WARNING: every analytics number on file is simulated. Treat performance evidence as absent, not as measured.",
    );
  }

  lines.push("", "## Objectives (in priority order)");
  if (context.objectives.length === 0) lines.push("none defined");
  for (const objective of context.objectives) {
    lines.push(
      `- kpi=${objective.kpi} kind=${objective.kind} priority=${objective.priority} weight=${objective.normalisedWeight.toFixed(2)}${
        objective.attributionLimitations
          ? ` — cannot measure: ${objective.attributionLimitations}`
          : ""
      }`,
    );
  }

  lines.push("", "## Audiences");
  if (context.audiences.length === 0) lines.push("none defined");
  for (const audience of context.audiences) {
    lines.push(
      `- name="${audience.name}" awareness=${audience.awarenessStage} priority=${audience.priority}`,
    );
    if (audience.pains.length > 0) lines.push(`  pains: ${audience.pains.join("; ")}`);
    if (audience.desires.length > 0) lines.push(`  desires: ${audience.desires.join("; ")}`);
    if (audience.objections.length > 0) {
      lines.push(`  objections: ${audience.objections.join("; ")}`);
    }
  }

  lines.push("", "## Content pillars");
  lines.push(context.pillars.map((pillar) => pillar.name).join(", ") || "none defined");

  lines.push("", "## Evidence by dimension");
  for (const digest of context.dimensions) {
    lines.push(`### ${digest.dimension}`);
    if (digest.options.length === 0) {
      lines.push("no evidence");
      continue;
    }
    for (const option of digest.options) {
      lines.push(
        `- option="${option.groupKey}" score=${option.score} strength=${option.strength} ` +
          `classes=${option.classes.join("/")}${option.priorOnly ? " PRIOR-ONLY" : ""}`,
      );
      lines.push(`  claim: ${option.claim}`);
      lines.push(`  evidenceIds: ${option.evidenceIds.join(", ")}`);
    }
  }

  lines.push("", `Allowed format values: ${Object.values(ContentFormat).join(", ")}`);
  lines.push(
    "",
    "Write the strategy. Cite only the evidence ids above; an empty basedOn is how",
    "you say an idea is untested.",
  );

  return lines.join("\n");
}

/** Only an account observation or an experiment can justify above LOW. */
function confidenceCeiling(context: StrategyContext): "LOW" | "MEDIUM" | "HIGH" {
  const { accountState } = context;
  if (accountState.cold || accountState.analyticsAreSimulated) return "LOW";
  if (accountState.experiments > 0 && accountState.accountObservations >= 12) return "HIGH";
  if (accountState.accountObservations >= 4) return "MEDIUM";
  return "LOW";
}

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

export const strategyDraftPrompt = registerPrompt<StrategyDraftInput, StrategyDraftOutput>({
  name: "strategy-draft",
  version: "1.0.0",
  operation: AIOperation.STRATEGY_DRAFT,
  description:
    "Drafts a versioned content strategy for one brand from its own evidence and general priors, citing evidence by id.",
  schema: strategyDraftSchema,
  maxOutputTokens: 4_000,

  render(context) {
    return { system: SYSTEM, user: renderUser(context) };
  },

  /**
   * The rule-based strategy: take the best-supported option in each dimension,
   * the highest-priority audience and objective, and turn the weakest parts of
   * the picture into hypotheses and risks.
   *
   * It is a real strategy, not a placeholder — a cold-start account planning from
   * priors is exactly the case this has to handle, and it is the same case the
   * model would be handling.
   */
  deterministic(context) {
    const pick = (dimension: string, count = 2) =>
      context.dimensions
        .find((digest) => digest.dimension === dimension)
        ?.options.filter((option) => option.score > 0)
        .slice(0, count) ?? [];

    const hooks = pick("hook", 3);
    const formats = pick("format", 3);
    const ctas = pick("cta", 1);
    const cadence = pick("cadence", 1);

    const audience = context.audiences[0] ?? null;
    const primary = context.objectives[0] ?? null;
    const secondary = context.objectives[1] ?? null;

    const validFormats = new Set<string>(Object.values(ContentFormat));
    const recommendedFormats = formats
      .map((option) => option.groupKey)
      .filter((key) => validFormats.has(key));

    const hypotheses = (hooks.length > 0 ? hooks : formats).slice(0, 3).map((option) => ({
      claim: `"${option.groupKey}" is worth leaning on for ${primary?.kpi ?? "the primary KPI"}: ${option.claim}`,
      dimension: hooks.includes(option) ? "hook" : "format",
      howToTest: option.priorOnly
        ? `Publish at least six posts using "${option.groupKey}" against a mixed control set, then compare ${primary?.kpi ?? "the primary KPI"} before treating it as established.`
        : `Run a controlled variant on "${option.groupKey}" so the association can be separated from topic and timing.`,
      basedOn: option.evidenceIds,
    }));

    if (hypotheses.length === 0) {
      hypotheses.push({
        claim:
          "There is no evidence yet for any creative direction, so the first weeks are a mapping exercise rather than an optimisation.",
        dimension: "hook",
        howToTest:
          "Publish deliberately varied hooks and formats, and let the first analytics window decide what to narrow to.",
        // Deliberately empty: nothing supports this, and it should read that way.
        basedOn: [],
      });
    }

    const risks: Array<{ risk: string; mitigation: string }> = [];
    if (context.accountState.cold) {
      risks.push({
        risk: "This strategy rests on general priors. Nothing has been observed on this account, so any of it may be wrong for this audience.",
        mitigation:
          "Treat the first cycle as measurement: keep variation deliberately wide and revise once real results exist.",
      });
    }
    if (context.accountState.analyticsAreSimulated) {
      risks.push({
        risk: "Every analytics number on file is simulated, so apparent performance is not evidence of anything.",
        mitigation:
          "Connect an account and publish for real before letting performance drive a decision.",
      });
    }
    const unmeasurable = context.objectives.filter((o) => o.attributionLimitations);
    for (const objective of unmeasurable) {
      risks.push({
        risk: `${objective.kpi} cannot be attributed reliably: ${objective.attributionLimitations}`,
        mitigation: `Judge ${objective.kpi} on trend rather than per-post attribution, and use a measurable proxy for optimisation.`,
      });
    }
    if (risks.length === 0) {
      risks.push({
        risk: "Evidence so far is associative — it cannot separate the creative choice from topic, timing or the algorithm.",
        mitigation: "Promote the strongest association to a controlled experiment before treating it as causal.",
      });
    }

    const platformStrategy: Record<string, string> = {};
    for (const platform of context.accountState.connectedPlatforms) {
      platformStrategy[platform] =
        `Publish the same creative, and read ${primary?.kpi ?? "the primary KPI"} per platform separately — nothing here assumes the platforms behave alike.`;
    }

    return {
      summary: buildSummary(context, hooks, formats),
      targetAudienceName: audience?.name ?? null,
      primaryObjectiveKpi: primary?.kpi ?? null,
      secondaryObjectiveKpi: secondary?.kpi ?? null,
      contentPillars: context.pillars.map((pillar) => pillar.name),
      recommendedFormats:
        recommendedFormats.length > 0 ? recommendedFormats : [ContentFormat.TALKING_HEAD],
      hookFamilies:
        hooks.length > 0 ? hooks.map((option) => option.groupKey) : ["direct"],
      narrativeStructures: hooks.length > 1 ? ["problem-solution", "demonstration"] : [],
      ctaStrategy: ctas[0]
        ? `Lead with "${ctas[0].groupKey}": ${ctas[0].claim}`
        : `Use the brand's stated call to action: ${context.brand.primaryCta}`,
      platformStrategy,
      cadence: {
        postsPerWeek: cadence[0]?.groupKey === "daily" ? 7 : 4,
        notes: cadence[0]
          ? cadence[0].claim
          : "No cadence evidence yet. Four a week is a rate this operation can sustain while it learns; it is not a finding.",
      },
      hypotheses,
      risks,
      // The rules never claim more than the account's evidence allows.
      confidence: confidenceCeiling(context),
    };
  },

  refine(value, context) {
    const problems: string[] = [];

    const citable = new Set(context.citableEvidenceIds);
    value.hypotheses.forEach((hypothesis, index) => {
      const invented = hypothesis.basedOn.filter((id) => !citable.has(id));
      if (invented.length > 0) {
        problems.push(
          `hypotheses.${index}.basedOn: ${invented.join(", ")} ${invented.length === 1 ? "is not an id" : "are not ids"} from the supplied evidence. Cite only supplied ids, or leave basedOn empty to mark the idea untested.`,
        );
      }
    });

    if (value.targetAudienceName !== null && context.audiences.length > 0) {
      const names = context.audiences.map((audience) => audience.name);
      if (!names.includes(value.targetAudienceName)) {
        problems.push(
          `targetAudienceName: "${value.targetAudienceName}" is not one of this brand's audiences (${names.join(", ")}).`,
        );
      }
    }

    const kpis = context.objectives.map((objective) => objective.kpi);
    for (const field of ["primaryObjectiveKpi", "secondaryObjectiveKpi"] as const) {
      const kpi = value[field];
      if (kpi !== null && kpis.length > 0 && !kpis.includes(kpi)) {
        problems.push(`${field}: "${kpi}" is not a defined objective (${kpis.join(", ")}).`);
      }
    }

    if (context.pillars.length > 0) {
      const names = context.pillars.map((pillar) => pillar.name);
      const unknown = value.contentPillars.filter((pillar) => !names.includes(pillar));
      if (unknown.length > 0) {
        problems.push(
          `contentPillars: ${unknown.join(", ")} are not this brand's pillars (${names.join(", ")}).`,
        );
      }
    }

    const validFormats = new Set<string>(Object.values(ContentFormat));
    const badFormats = value.recommendedFormats.filter((format) => !validFormats.has(format));
    if (badFormats.length > 0) {
      problems.push(
        `recommendedFormats: ${badFormats.join(", ")} are not valid formats (${Object.values(ContentFormat).join(", ")}).`,
      );
    }

    const ceiling = confidenceCeiling(context);
    if (RANK[value.confidence] > RANK[ceiling]) {
      problems.push(
        `confidence: this account supports at most ${ceiling} — ${context.accountState.reason} Lower the confidence rather than the standard.`,
      );
    }

    for (const topic of context.brand.prohibitedTopics) {
      const needle = topic.toLowerCase();
      if (needle !== "" && value.summary.toLowerCase().includes(needle)) {
        problems.push(`summary: mentions the prohibited topic "${topic}".`);
      }
    }

    return problems;
  },
});

function buildSummary(
  context: StrategyContext,
  hooks: Array<{ groupKey: string }>,
  formats: Array<{ groupKey: string }>,
): string {
  const objective = context.objectives[0]?.kpi ?? "no stated objective";
  const audience = context.audiences[0]?.name ?? context.brand.audience;
  const basis = context.accountState.cold
    ? "This is built from general priors and the brand's stated context; nothing has been observed on this account yet, so treat every choice as a hypothesis"
    : `This is built from ${context.accountState.accountObservations} observation${context.accountState.accountObservations === 1 ? "" : "s"} of this account plus general priors`;

  const lean =
    hooks.length > 0 || formats.length > 0
      ? `Lean on ${[...hooks.map((h) => `${h.groupKey} hooks`), ...formats.map((f) => `${f.groupKey} formats`)].join(" and ")}.`
      : "There is no evidence yet favouring any hook or format, so vary both deliberately.";

  return `${context.projectName} publishes for ${audience}, optimising for ${objective}. ${lean} ${basis}.`;
}
