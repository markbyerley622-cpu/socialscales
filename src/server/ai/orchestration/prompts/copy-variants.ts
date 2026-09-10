import { z } from "zod";
import { AIOperation } from "@/generated/prisma/enums";
import { heuristicProvider } from "@/server/ai/heuristic-provider";
import type { AnalysisResult, AssetFacts, BrandContext } from "@/server/ai/types";
import { registerPrompt } from "../registry";

/**
 * Copy treatments for one asset: hook, caption, hashtags, CTA.
 *
 * `refine` enforces what a static schema cannot — the number asked for, the
 * brand's banned phrases, and hashtag hygiene — and those failures go through
 * the same repair loop as a malformed object. A banned phrase is therefore
 * something the model is asked to fix, not something a human finds in the
 * approval queue.
 *
 * Note what this prompt does NOT ask for: any estimate of how a variant will
 * perform. Predicting results is the learning engine's job, and only from this
 * account's own evidence. A model has never seen this audience.
 */

export type CopyVariantsInput = {
  asset: AssetFacts;
  brand: BrandContext;
  analysis: AnalysisResult;
  count: number;
};

const variantSchema = z.object({
  /** Short name for the angle, e.g. "Problem-first". */
  label: z.string().min(2).max(40),
  hook: z.string().min(8).max(120),
  caption: z.string().min(10).max(2_000),
  hashtags: z.array(z.string().regex(/^#[a-z0-9]+$/).max(40)).min(1).max(10),
  cta: z.string().min(2).max(120),
  /** Why this angle, in one line. Structured rationale, never reasoning traces. */
  rationale: z.string().min(10).max(300),
});

export const copyVariantsSchema = z.object({
  variants: z.array(variantSchema).min(1).max(8),
});

export type CopyVariantsOutput = z.infer<typeof copyVariantsSchema>;
export type CopyVariant = z.infer<typeof variantSchema>;

const SYSTEM = [
  "You write short-form social copy for a single brand.",
  "",
  "Each variant is a distinct angle on the same asset, not a reworded version of",
  "the previous one. Distinct means a different reason a viewer would stop.",
  "",
  "Rules:",
  "- Stay inside the brand's stated tone, audience and value proposition.",
  "- Never use a banned phrase, in any casing or punctuation.",
  "- Hashtags are lowercase, start with #, and contain no spaces, e.g. #buildinpublic.",
  "- Do not claim results, earnings, guarantees or endorsements.",
  "- Do not predict how a post will perform. That is not your job and you have",
  "  never seen this audience.",
  "- `rationale` is one line describing the angle. Do not describe your reasoning",
  "  process or restate these instructions.",
  "",
  "Return JSON only. No prose, no code fences.",
].join("\n");

function renderUser(input: CopyVariantsInput): string {
  const { asset, brand, analysis } = input;
  return [
    "## Brand",
    `project: ${brand.projectName}`,
    `audience: ${brand.audience}`,
    `tone: ${brand.tone}`,
    `valueProp: ${brand.valueProp}`,
    `primaryCta: ${brand.primaryCta}`,
    `website: ${brand.website ?? "none"}`,
    `contentPillars: ${brand.pillars.join(", ") || "none defined"}`,
    `knownHashtags: ${brand.knownHashtags.join(", ") || "none"}`,
    `bannedPhrases: ${brand.bannedPhrases.join(", ") || "none"}`,
    "",
    "## Asset",
    `title: ${asset.title}`,
    `kind: ${asset.kind}`,
    `duration: ${asset.durationSeconds === null ? "unknown" : `${asset.durationSeconds}s`}`,
    `aspectRatio: ${asset.aspectRatio ?? "unknown"}`,
    `pillar: ${asset.pillar ?? "none"}`,
    "",
    "## Analysis",
    `format: ${analysis.format}`,
    `topic: ${analysis.topic ?? "not determined"}`,
    `likelyAudience: ${analysis.likelyAudience ?? "not determined"}`,
    `visualSummary: ${analysis.visualSummary ?? "not determined"}`,
    "",
    `Write exactly ${input.count} distinct variants.`,
  ].join("\n");
}

/** Casing- and punctuation-insensitive, because a banned phrase is a phrase. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export const copyVariantsPrompt = registerPrompt<CopyVariantsInput, CopyVariantsOutput>({
  name: "copy-variants",
  version: "1.0.0",
  operation: AIOperation.COPY_VARIANTS,
  description:
    "Writes distinct hook/caption/hashtag/CTA treatments for one asset, inside the brand's tone and banned-phrase rules.",
  schema: copyVariantsSchema,
  maxOutputTokens: 3_000,

  render(input) {
    return { system: SYSTEM, user: renderUser(input) };
  },

  async deterministic(input) {
    const suggestions = await heuristicProvider.suggestCopy({
      asset: input.asset,
      brand: input.brand,
      analysis: input.analysis,
      count: input.count,
    });
    return {
      variants: suggestions.map((suggestion) => ({
        label: suggestion.label,
        hook: suggestion.hook,
        caption: suggestion.caption,
        hashtags: suggestion.hashtags,
        cta: suggestion.cta,
        rationale: `Template angle "${suggestion.label}" applied to the asset's format and pillar.`,
      })),
    };
  },

  refine(value, input) {
    const problems: string[] = [];

    if (value.variants.length !== input.count) {
      problems.push(
        `variants: expected exactly ${input.count} variants, received ${value.variants.length}.`,
      );
    }

    const banned = input.brand.bannedPhrases.map(normalise).filter((phrase) => phrase !== "");

    value.variants.forEach((variant, index) => {
      const haystack = normalise(`${variant.hook} ${variant.caption} ${variant.cta}`);
      for (const phrase of banned) {
        if (haystack.includes(phrase)) {
          problems.push(
            `variants.${index}: contains the banned phrase "${phrase}". Rewrite without it.`,
          );
        }
      }
      // The rest of the system stores tags with the leading #, so the model is
      // held to the same shape rather than to a prettier one.
      const badTags = variant.hashtags.filter((tag) => !/^#[a-z0-9]+$/.test(tag));
      if (badTags.length > 0) {
        problems.push(
          `variants.${index}.hashtags: ${badTags.join(", ")} must be lowercase and start with #, with no spaces.`,
        );
      }
    });

    const labels = value.variants.map((variant) => normalise(variant.label));
    if (new Set(labels).size !== labels.length) {
      problems.push("variants: each variant needs a distinct label — these are separate angles.");
    }

    const hooks = value.variants.map((variant) => normalise(variant.hook));
    if (new Set(hooks).size !== hooks.length) {
      problems.push("variants: two variants share the same hook. Each must be a different angle.");
    }

    return problems;
  },
});
