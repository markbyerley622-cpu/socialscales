import type { ContentFormat } from "@/generated/prisma/enums";

/**
 * The AI boundary. Everything upstream of this file talks to `AiProvider` only,
 * so swapping the heuristic provider for a hosted model is a one-file change.
 */

/** Brand context a provider is allowed to use when writing copy. */
export type BrandContext = {
  projectName: string;
  audience: string;
  tone: string;
  valueProp: string;
  primaryCta: string;
  website: string | null;
  bannedPhrases: string[];
  pillars: string[];
  knownHashtags: string[];
};

export type AssetFacts = {
  title: string;
  originalFilename: string;
  kind: "VIDEO" | "IMAGE";
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  aspectRatio: string | null;
  hasAudio: boolean | null;
  pillar: string | null;
};

export type AnalysisResult = {
  format: ContentFormat;
  topic: string | null;
  likelyAudience: string | null;
  visualSummary: string | null;
  transcript: string | null;
  /** Whatever the provider wants preserved for auditing. */
  raw: Record<string, unknown>;
};

export type CopySuggestion = {
  label: string;
  hook: string;
  caption: string;
  hashtags: string[];
  cta: string;
};

/**
 * Heuristic quality scores, 0..10. These are explicitly NOT predictions of
 * performance — the UI labels them as writing heuristics, and the learning
 * engine is the only thing allowed to talk about expected results.
 */
export type Scorecard = {
  hook: number;
  clarity: number;
  curiosity: number;
  cta: number;
  trendRelevance: number;
  notes: string[];
};

export type AiProvider = {
  readonly name: string;
  readonly model: string;
  /** True when the provider can transcribe audio. */
  readonly canTranscribe: boolean;
  analyzeAsset(input: {
    asset: AssetFacts;
    brand: BrandContext;
  }): Promise<AnalysisResult>;
  suggestCopy(input: {
    asset: AssetFacts;
    brand: BrandContext;
    analysis: AnalysisResult;
    count: number;
  }): Promise<CopySuggestion[]>;
  scoreCopy(input: {
    suggestion: CopySuggestion;
    brand: BrandContext;
    analysis: AnalysisResult;
  }): Scorecard;
};
