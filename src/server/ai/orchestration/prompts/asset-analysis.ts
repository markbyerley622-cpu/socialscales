import { z } from "zod";
import { AIOperation, ContentFormat } from "@/generated/prisma/enums";
import { heuristicProvider } from "@/server/ai/heuristic-provider";
import type { AssetFacts, BrandContext } from "@/server/ai/types";
import { registerPrompt } from "../registry";

/**
 * What is this asset, and what can honestly be said about it?
 *
 * The output schema is built around the rule that unsupported guesses must not
 * be stored as fact: every conclusion has to arrive with the `basis` it rests
 * on and a `confidence`, and anything the analysis could not determine has to be
 * named in `unknowns` rather than filled in plausibly. A model that wants to
 * assert a topic must say what in the input told it so.
 */

export type AssetAnalysisInput = {
  asset: AssetFacts;
  brand: BrandContext;
};

export const assetAnalysisSchema = z.object({
  format: z.enum(Object.values(ContentFormat) as [string, ...string[]]),
  /** Null is a valid answer. It is better than an invented topic. */
  topic: z.string().min(3).max(120).nullable(),
  likelyAudience: z.string().min(3).max(240).nullable(),
  visualSummary: z.string().min(3).max(600).nullable(),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  /** What the conclusions rest on. At least one, so nothing is asserted bare. */
  basis: z.array(z.string().min(3).max(200)).min(1).max(6),
  /** What could not be determined. Named, not guessed at. */
  unknowns: z.array(z.string().min(3).max(200)).max(6),
});

export type AssetAnalysisOutput = z.infer<typeof assetAnalysisSchema>;

const SYSTEM = [
  "You analyse short-form video and image assets for a content operations system.",
  "",
  "You are given container facts (filename, duration, dimensions, audio presence)",
  "and the brand's own description of itself. You cannot see or hear the media.",
  "",
  "Rules:",
  "- Never state something the input does not support. If the filename and the",
  "  container facts do not tell you the topic, return null for topic and say so",
  "  in unknowns.",
  "- Every conclusion you do draw must appear in `basis`, phrased as what you",
  "  observed, e.g. \"filename contains 'tutorial'\" or \"9:16 with audio\".",
  "- confidence reflects the input, not your fluency. Filename-only inference is",
  "  LOW. Filename plus consistent container facts is MEDIUM. HIGH requires the",
  "  input to be genuinely unambiguous.",
  "- Do not describe your reasoning process. Return the structured result only.",
  "",
  "Return JSON only. No prose, no code fences.",
].join("\n");

function renderUser(input: AssetAnalysisInput): string {
  const { asset, brand } = input;
  return [
    "## Asset",
    `title: ${asset.title}`,
    `filename: ${asset.originalFilename}`,
    `kind: ${asset.kind}`,
    `duration: ${asset.durationSeconds === null ? "unknown" : `${asset.durationSeconds}s`}`,
    `dimensions: ${asset.width ?? "?"}x${asset.height ?? "?"}`,
    `aspectRatio: ${asset.aspectRatio ?? "unknown"}`,
    `hasAudio: ${asset.hasAudio === null ? "unknown" : asset.hasAudio}`,
    `assignedPillar: ${asset.pillar ?? "none"}`,
    "",
    "## Brand",
    `project: ${brand.projectName}`,
    `audience: ${brand.audience}`,
    `tone: ${brand.tone}`,
    `valueProp: ${brand.valueProp}`,
    `contentPillars: ${brand.pillars.join(", ") || "none defined"}`,
    "",
    `Allowed format values: ${Object.values(ContentFormat).join(", ")}`,
    "",
    "Analyse the asset under the rules in your instructions.",
  ].join("\n");
}

export const assetAnalysisPrompt = registerPrompt<AssetAnalysisInput, AssetAnalysisOutput>({
  name: "asset-analysis",
  version: "1.0.0",
  operation: AIOperation.ASSET_ANALYSIS,
  description:
    "Classifies an uploaded asset's format and likely topic from container facts and brand context, with the basis for each conclusion.",
  schema: assetAnalysisSchema,
  maxOutputTokens: 1_200,

  render(input) {
    return { system: SYSTEM, user: renderUser(input) };
  },

  /**
   * The rule-based equivalent: the existing filename and container heuristics.
   * It is honest about its own ceiling — a filename can never justify better
   * than LOW confidence, and it names what it could not see.
   */
  async deterministic(input) {
    const analysis = await heuristicProvider.analyzeAsset({
      asset: input.asset,
      brand: input.brand,
    });

    const basis: string[] = [`filename tokens: ${input.asset.originalFilename}`];
    if (input.asset.aspectRatio) basis.push(`aspect ratio ${input.asset.aspectRatio}`);
    if (input.asset.durationSeconds !== null) {
      basis.push(`duration ${input.asset.durationSeconds}s`);
    }
    if (input.asset.pillar) basis.push(`assigned content pillar "${input.asset.pillar}"`);

    const unknowns = ["what is said or shown in the media itself"];
    if (input.asset.hasAudio === null) unknowns.push("whether the asset has audio");
    if (!analysis.topic) unknowns.push("the specific topic");

    return {
      format: analysis.format,
      topic: analysis.topic,
      likelyAudience: analysis.likelyAudience,
      visualSummary: analysis.visualSummary,
      // A filename is a weak signal and the rules say so rather than borrowing
      // confidence from the fact that a computer produced the answer.
      confidence: "LOW" as const,
      basis: basis.slice(0, 6),
      unknowns: unknowns.slice(0, 6),
    };
  },

  refine(value) {
    const problems: string[] = [];
    if (value.topic !== null && value.confidence === "HIGH" && value.basis.length < 2) {
      problems.push(
        "confidence: HIGH confidence needs at least two items in basis. Lower the confidence or state what else supports it.",
      );
    }
    if (value.topic === null && value.unknowns.length === 0) {
      problems.push(
        "unknowns: topic is null, so unknowns must say what prevented determining it.",
      );
    }
    return problems;
  },
});
