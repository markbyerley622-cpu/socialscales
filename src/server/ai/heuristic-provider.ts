import { ContentFormat } from "@/generated/prisma/enums";
import type {
  AiProvider,
  AnalysisResult,
  AssetFacts,
  BrandContext,
  CopySuggestion,
  Scorecard,
} from "./types";

/**
 * A fully local provider. It reads the filename, the probed container facts and
 * the project's brand context, and produces deterministic suggestions from
 * templates. No network, no credentials.
 *
 * It is deliberately transparent about its limits: it cannot transcribe, and it
 * never claims to know what a video is "about" beyond what the filename and
 * pillar say.
 */

const FORMAT_KEYWORDS: Array<[ContentFormat, string[]]> = [
  [ContentFormat.SCREEN_RECORDING, ["screen", "demo", "recording", "walkthrough", "app", "dashboard", "ui"]],
  [ContentFormat.TUTORIAL, ["tutorial", "howto", "how-to", "guide", "setup", "tut"]],
  [ContentFormat.TALKING_HEAD, ["talking", "head", "camera", "selfie", "vlog", "pov"]],
  [ContentFormat.COMPARISON, ["vs", "versus", "compare", "comparison", "before", "after"]],
  [ContentFormat.LIST, ["top", "list", "tips", "ways", "reasons", "hacks"]],
  [ContentFormat.REACTION, ["reaction", "react", "responds", "reply"]],
  [ContentFormat.BUILD_IN_PUBLIC, ["build", "day", "building", "shipping", "progress", "bip"]],
  [ContentFormat.STORY, ["story", "journey", "how-i", "why-i"]],
];

/** Filenames are the only free-text signal available, so normalise them well. */
function tokenize(filename: string): string[] {
  return filename
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 1 && !/^\d+$/.test(part));
}

function detectFormat(facts: AssetFacts): ContentFormat {
  const tokens = new Set(tokenize(facts.originalFilename).concat(tokenize(facts.title)));
  for (const [format, keywords] of FORMAT_KEYWORDS) {
    if (keywords.some((keyword) => tokens.has(keyword))) return format;
  }
  if (facts.kind === "IMAGE") return ContentFormat.LIST;
  if (facts.hasAudio === false) return ContentFormat.SCREEN_RECORDING;
  return ContentFormat.UNKNOWN;
}

function titleCase(text: string): string {
  return text
    .split(" ")
    .map((word) => (word.length ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function topicFrom(facts: AssetFacts): string | null {
  const tokens = tokenize(facts.originalFilename).filter(
    (token) => !["final", "export", "render", "v1", "v2", "draft", "copy", "mp4", "mov"].includes(token),
  );
  if (facts.pillar) return facts.pillar;
  if (tokens.length === 0) return null;
  return titleCase(tokens.slice(0, 4).join(" "));
}

function describeShape(facts: AssetFacts): string {
  const parts: string[] = [];
  if (facts.aspectRatio) {
    parts.push(
      facts.aspectRatio === "9:16"
        ? "vertical 9:16, native to short-form feeds"
        : `${facts.aspectRatio} framing`,
    );
  }
  if (facts.durationSeconds !== null) {
    parts.push(`${Math.round(facts.durationSeconds)}s runtime`);
  }
  if (facts.width && facts.height) parts.push(`${facts.width}x${facts.height}`);
  if (facts.hasAudio === false) parts.push("no audio track (needs captions or music)");
  if (facts.hasAudio === true) parts.push("has audio");
  return parts.length ? parts.join(" · ") : "container details unavailable";
}

// ---------------------------------------------------------------------------
// Copy templates
// ---------------------------------------------------------------------------

type Template = {
  label: string;
  hook: (ctx: TemplateContext) => string;
  caption: (ctx: TemplateContext) => string;
};

type TemplateContext = {
  subject: string;
  audienceNoun: string;
  valueProp: string;
  cta: string;
};

const TEMPLATES: Template[] = [
  {
    label: "Problem / solution",
    hook: (c) => `Stop doing ${c.subject} the hard way.`,
    caption: (c) =>
      `Most ${c.audienceNoun} still do ${c.subject} manually. ${c.valueProp}\n\n${c.cta}`,
  },
  {
    label: "POV",
    hook: (c) => `POV: you just fixed ${c.subject} in one afternoon.`,
    caption: (c) =>
      `This is what ${c.subject} looks like when it finally works. ${c.valueProp}\n\n${c.cta}`,
  },
  {
    label: "Direct question",
    hook: (c) => `What if ${c.subject} took 30 seconds instead of a week?`,
    caption: (c) =>
      `Genuine question for ${c.audienceNoun}: how long does ${c.subject} take you today? ${c.valueProp}\n\n${c.cta}`,
  },
  {
    label: "Contrarian",
    hook: (c) => `Nobody needs another tool for ${c.subject}. Here is what they need instead.`,
    caption: (c) => `${c.valueProp} Built for ${c.audienceNoun} who are tired of ${c.subject}.\n\n${c.cta}`,
  },
  {
    label: "Build in public",
    hook: (c) => `Day 1 of making ${c.subject} actually usable.`,
    caption: (c) =>
      `Building this in the open. Today: ${c.subject}. ${c.valueProp}\n\n${c.cta}`,
  },
];

/** Naive singular→plural for the audience noun used inside captions. */
function audienceNoun(audience: string): string {
  const first = audience.split(/[,/]|\band\b/)[0].trim().toLowerCase();
  if (!first) return "people";
  if (first.endsWith("s")) return first;
  return `${first}s`;
}

function selectHashtags(brand: BrandContext, facts: AssetFacts, limit = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (raw: string) => {
    const tag = raw.replace(/^#/, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (tag.length < 3 || tag.length > 24) return;
    if (seen.has(tag)) return;
    seen.add(tag);
    out.push(`#${tag}`);
  };

  // Project's own proven tags first, then pillar, then filename tokens.
  brand.knownHashtags.forEach(push);
  if (facts.pillar) push(facts.pillar.replace(/\s+/g, ""));
  tokenize(facts.originalFilename).forEach(push);
  brand.pillars.slice(0, 2).forEach((pillar) => push(pillar.replace(/\s+/g, "")));

  // A small relevant set beats a wall of tags.
  return out.slice(0, limit);
}

function stripBanned(text: string, banned: string[]): string {
  let result = text;
  for (const phrase of banned) {
    if (!phrase.trim()) continue;
    result = result.replace(new RegExp(escapeRegex(phrase), "gi"), "").replace(/\s{2,}/g, " ");
  }
  return result.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const CURIOSITY_MARKERS = ["?", "what if", "pov", "nobody", "stop", "why", "how"];
const CLARITY_MAX_HOOK_WORDS = 12;

function clamp(value: number, min = 0, max = 10): number {
  return Math.max(min, Math.min(max, Math.round(value * 10) / 10));
}

function scoreSuggestion(
  suggestion: CopySuggestion,
  brand: BrandContext,
): Scorecard {
  const notes: string[] = [];
  const hook = suggestion.hook.trim();
  const hookWords = hook.split(/\s+/).filter(Boolean).length;

  // Hook: rewards a short, specific opener that leads with a concrete noun.
  let hookScore = 6;
  if (hookWords <= CLARITY_MAX_HOOK_WORDS) hookScore += 1.5;
  else notes.push(`Hook is ${hookWords} words; under ${CLARITY_MAX_HOOK_WORDS} reads faster on mute.`);
  if (/^[A-Z]/.test(hook)) hookScore += 0.5;
  if (/\d/.test(hook)) hookScore += 1;
  else notes.push("A concrete number in the hook usually lifts retention.");
  if (hook.length > 90) {
    hookScore -= 1.5;
    notes.push("Hook may be truncated in-feed over ~90 characters.");
  }

  // Clarity: penalise long sentences and hedging language.
  const sentences = suggestion.caption.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const avgWords =
    sentences.reduce((sum, s) => sum + s.trim().split(/\s+/).length, 0) /
    Math.max(1, sentences.length);
  let clarity = 9 - Math.max(0, avgWords - 14) * 0.35;
  if (/\b(maybe|possibly|kind of|sort of|might)\b/i.test(suggestion.caption)) {
    clarity -= 1;
    notes.push("Hedging words weaken the caption.");
  }

  // Curiosity: does the copy open a loop?
  const curiosityHits = CURIOSITY_MARKERS.filter((marker) =>
    hook.toLowerCase().includes(marker),
  ).length;
  const curiosity = 5.5 + curiosityHits * 1.5;

  // CTA: is there one, and is it specific?
  let ctaScore = suggestion.cta.trim() ? 7 : 3;
  if (!suggestion.cta.trim()) notes.push("No CTA — profile visits rarely convert without one.");
  if (/\b(link in bio|comment|dm|join|start|try|book)\b/i.test(suggestion.cta)) ctaScore += 1.5;
  if (suggestion.cta.split(/\s+/).length > 12) {
    ctaScore -= 1;
    notes.push("CTA is long; one action reads better than two.");
  }

  // Trend relevance: overlap with the project's established tags and pillars.
  const known = new Set(
    brand.knownHashtags.map((tag) => tag.replace(/^#/, "").toLowerCase()),
  );
  const overlap = suggestion.hashtags.filter((tag) =>
    known.has(tag.replace(/^#/, "").toLowerCase()),
  ).length;
  const trendRelevance = suggestion.hashtags.length
    ? clamp(4 + (overlap / suggestion.hashtags.length) * 6)
    : 3;
  if (suggestion.hashtags.length === 0) notes.push("No hashtags selected.");
  if (suggestion.hashtags.length > 10) {
    notes.push("Over 10 hashtags reads as spam; a small relevant set performs better.");
  }

  return {
    hook: clamp(hookScore),
    clarity: clamp(clarity),
    curiosity: clamp(curiosity),
    cta: clamp(ctaScore),
    trendRelevance,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const heuristicProvider: AiProvider = {
  name: "heuristic",
  model: "rules-v1",
  canTranscribe: false,

  async analyzeAsset({ asset, brand }): Promise<AnalysisResult> {
    const format = detectFormat(asset);
    const topic = topicFrom(asset);
    return {
      format,
      topic,
      likelyAudience: brand.audience,
      visualSummary: describeShape(asset),
      // Honest about the limit rather than inventing a transcript.
      transcript: null,
      raw: {
        provider: "heuristic",
        signals: {
          filenameTokens: tokenize(asset.originalFilename),
          detectedFormat: format,
          pillar: asset.pillar,
        },
        limitations: [
          "No transcription: the heuristic provider does not process audio.",
          "Topic is inferred from filename and content pillar only.",
        ],
      },
    };
  },

  async suggestCopy({ asset, brand, analysis, count }): Promise<CopySuggestion[]> {
    const subject =
      analysis.topic?.toLowerCase() ??
      asset.pillar?.toLowerCase() ??
      brand.valueProp.split(/[.,]/)[0].toLowerCase();

    const ctx: TemplateContext = {
      subject,
      audienceNoun: audienceNoun(brand.audience),
      valueProp: brand.valueProp,
      cta: brand.primaryCta,
    };

    const hashtags = selectHashtags(brand, asset);

    return TEMPLATES.slice(0, Math.max(1, count)).map((template) => ({
      label: template.label,
      hook: stripBanned(template.hook(ctx), brand.bannedPhrases),
      caption: stripBanned(template.caption(ctx), brand.bannedPhrases),
      hashtags,
      cta: brand.primaryCta,
    }));
  },

  scoreCopy({ suggestion, brand }): Scorecard {
    return scoreSuggestion(suggestion, brand);
  },
};
