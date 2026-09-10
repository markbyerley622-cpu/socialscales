import { z } from "zod";
import { AIOperation, ContentFormat } from "@/generated/prisma/enums";
import { registerPrompt } from "../registry";

/**
 * The shot-level plan for one variant.
 *
 * A hook and a caption are not a shootable piece of content. This is what turns
 * them into one: ordered beats with timings, what is on screen, what is said,
 * and where the ask lands.
 *
 * The load-bearing check is `deliversKeyMessage`. A brief commissions a piece to
 * say a particular thing; a treatment that does not say it is a different piece
 * wearing the brief's name. Claiming delivery is therefore something the
 * treatment has to justify, and `refine` rejects a claim the beats do not
 * support.
 */

export type TreatmentInput = {
  /** What the brief asked for. Null when the variant has no brief. */
  brief: {
    workingTitle: string;
    angle: string;
    keyMessage: string;
    format: string;
    hookFamily: string | null;
    minSeconds: number | null;
    maxSeconds: number | null;
    productionNotes: string | null;
  } | null;
  variant: {
    label: string;
    hook: string;
    caption: string;
    cta: string;
  };
  asset: {
    title: string;
    kind: string;
    durationSeconds: number | null;
    aspectRatio: string | null;
    hasAudio: boolean | null;
  };
  brand: {
    tone: string;
    audience: string;
    valueProp: string;
    primaryCta: string;
    bannedPhrases: string[];
    prohibitedTopics: string[];
  };
  narrativeStructures: string[];
};

const CTA_PLACEMENTS = ["END", "MID", "OVERLAY_THROUGHOUT", "PINNED_COMMENT"] as const;

const beatSchema = z
  .object({
    startSeconds: z.number().min(0).max(600),
    endSeconds: z.number().min(0.5).max(600),
    /** What the camera shows. */
    shot: z.string().min(6).max(300),
    /** Burned-in text, or null when the beat carries none. */
    onScreenText: z.string().max(120).nullable(),
    /** What is said, or null for a silent beat. */
    voiceover: z.string().max(400).nullable(),
  })
  .refine((beat) => beat.endSeconds > beat.startSeconds, {
    message: "endSeconds must be after startSeconds",
  });

export const creativeTreatmentSchema = z.object({
  narrativeStructure: z.string().min(3).max(60),
  hookFamily: z.string().min(2).max(60),
  beats: z.array(beatSchema).min(2).max(12),
  ctaPlacement: z.enum(CTA_PLACEMENTS),
  /** Whether the beats actually deliver the brief's key message. */
  deliversKeyMessage: z.boolean(),
  /** One line saying which beat carries the message, or what is missing. */
  keyMessageNote: z.string().min(10).max(300),
});

export type CreativeTreatmentOutput = z.infer<typeof creativeTreatmentSchema>;
export type TreatmentBeat = z.infer<typeof beatSchema>;

const SYSTEM = [
  "You turn a hook and a caption into a shootable treatment for one short video.",
  "",
  "Rules:",
  "- Beats are ordered and must not overlap. The first beat starts at 0.",
  "- The first beat carries the hook. In short-form the opening frame does the",
  "  retention work, so it cannot be a title card or a logo.",
  "- On-screen text is short enough to read at a glance, or null.",
  "- Set voiceover to null for a beat with no speech. Do not write silence as an",
  "  empty string.",
  "- `deliversKeyMessage` is a claim about the beats you wrote, not about",
  "  intent. If no beat carries the brief's key message, say false and say what",
  "  is missing. A false answer is useful; a wrong true answer is not.",
  "- Never use a banned phrase or a prohibited topic, on screen or in voiceover.",
  "- Do not predict performance.",
  "",
  "Return JSON only. No prose, no code fences.",
].join("\n");

function renderUser(input: TreatmentInput): string {
  const lines: string[] = [];

  lines.push("## Variant");
  lines.push(`label: ${input.variant.label}`);
  lines.push(`hook: ${input.variant.hook}`);
  lines.push(`caption: ${input.variant.caption}`);
  lines.push(`cta: ${input.variant.cta}`);

  lines.push("", "## Asset");
  lines.push(`title: ${input.asset.title}`);
  lines.push(`kind: ${input.asset.kind}`);
  lines.push(
    `duration: ${input.asset.durationSeconds === null ? "unknown" : `${input.asset.durationSeconds}s`}`,
  );
  lines.push(`aspectRatio: ${input.asset.aspectRatio ?? "unknown"}`);
  lines.push(`hasAudio: ${input.asset.hasAudio === null ? "unknown" : input.asset.hasAudio}`);

  if (input.brief) {
    lines.push("", "## Brief this must satisfy");
    lines.push(`title: ${input.brief.workingTitle}`);
    lines.push(`angle: ${input.brief.angle}`);
    lines.push(`KEY MESSAGE: ${input.brief.keyMessage}`);
    lines.push(`format: ${input.brief.format}`);
    lines.push(`hookFamily: ${input.brief.hookFamily ?? "unspecified"}`);
    lines.push(
      `length: ${input.brief.minSeconds ?? "?"}-${input.brief.maxSeconds ?? "?"} seconds`,
    );
    if (input.brief.productionNotes) lines.push(`notes: ${input.brief.productionNotes}`);
  } else {
    lines.push("", "## No brief");
    lines.push("This variant was not commissioned by a brief, so there is no key message");
    lines.push("to check against. Set deliversKeyMessage to false and say so.");
  }

  lines.push("", "## Brand");
  lines.push(`tone: ${input.brand.tone}`);
  lines.push(`audience: ${input.brand.audience}`);
  lines.push(`valueProp: ${input.brand.valueProp}`);
  lines.push(`bannedPhrases: ${input.brand.bannedPhrases.join("; ") || "none"}`);
  lines.push(`prohibitedTopics: ${input.brand.prohibitedTopics.join("; ") || "none"}`);

  lines.push("", `Narrative structures the strategy favours: ${input.narrativeStructures.join(", ") || "none stated"}`);
  lines.push(`Allowed formats: ${Object.values(ContentFormat).join(", ")}`);
  lines.push("", "Write the treatment.");
  return lines.join("\n");
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Content words only, so "the" and "a" cannot carry a key-message claim. */
function keywords(text: string): string[] {
  const stop = new Set([
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
    "is", "it", "this", "that", "you", "your", "we", "our", "at", "by", "as",
    "be", "are", "was", "from", "so", "if", "not", "can", "will", "just",
  ]);
  return [
    ...new Set(
      normalise(text)
        .split(" ")
        .filter((word) => word.length > 2 && !stop.has(word)),
    ),
  ];
}

export const creativeTreatmentPrompt = registerPrompt<
  TreatmentInput,
  CreativeTreatmentOutput
>({
  name: "creative-treatment",
  version: "1.0.0",
  operation: AIOperation.CREATIVE_TREATMENT,
  description:
    "Turns a variant's hook and caption into an ordered, timed shot treatment, checked against its brief's key message.",
  schema: creativeTreatmentSchema,
  maxOutputTokens: 2_500,

  /**
   * The rule-based treatment: a three-beat structure — hook, substance, ask —
   * fitted to the brief's length range, with the brief's key message spoken in
   * the middle beat so the delivery claim is true by construction rather than
   * asserted.
   */
  deterministic(input) {
    const min = input.brief?.minSeconds ?? 15;
    const max = input.brief?.maxSeconds ?? Math.max(min + 10, 30);
    const total = Math.max(min, Math.min(max, input.asset.durationSeconds ?? min));

    const hookEnd = Math.max(2, Math.round(total * 0.15));
    const bodyEnd = Math.max(hookEnd + 1, Math.round(total * 0.8));

    const keyMessage = input.brief?.keyMessage ?? null;

    const beats: TreatmentBeat[] = [
      {
        startSeconds: 0,
        endSeconds: hookEnd,
        shot: `Open directly on the subject — no title card. ${input.variant.hook}`,
        onScreenText: input.variant.hook.slice(0, 120),
        voiceover: input.variant.hook,
      },
      {
        startSeconds: hookEnd,
        endSeconds: bodyEnd,
        shot: input.brief
          ? `Show the substance of the angle: ${input.brief.angle.slice(0, 240)}`
          : `Show the substance behind the hook, in the asset's own footage.`,
        onScreenText: null,
        voiceover: keyMessage ?? input.brand.valueProp,
      },
      {
        startSeconds: bodyEnd,
        endSeconds: total,
        shot: "Hold on the result while the ask lands.",
        onScreenText: input.variant.cta.slice(0, 120),
        voiceover: input.variant.cta,
      },
    ];

    return {
      narrativeStructure: input.narrativeStructures[0] ?? "hook-substance-ask",
      hookFamily: input.brief?.hookFamily ?? "direct",
      beats,
      ctaPlacement: "END" as const,
      // True by construction: the middle beat speaks the key message verbatim.
      // With no brief there is nothing to deliver, and it says so.
      deliversKeyMessage: keyMessage !== null,
      keyMessageNote: keyMessage
        ? `Beat 2 states the brief's key message directly: "${keyMessage.slice(0, 180)}"`
        : "This variant has no brief, so there is no key message to deliver.",
    };
  },

  render(input) {
    return { system: SYSTEM, user: renderUser(input) };
  },

  refine(value, input) {
    const problems: string[] = [];

    if (value.beats[0] && value.beats[0].startSeconds !== 0) {
      problems.push("beats.0.startSeconds: the first beat must start at 0.");
    }

    for (let index = 1; index < value.beats.length; index += 1) {
      const previous = value.beats[index - 1]!;
      const current = value.beats[index]!;
      if (current.startSeconds < previous.endSeconds) {
        problems.push(
          `beats.${index}: overlaps the previous beat, which ends at ${previous.endSeconds}s.`,
        );
      }
    }

    const total = value.beats[value.beats.length - 1]?.endSeconds ?? 0;
    const min = input.brief?.minSeconds ?? null;
    const max = input.brief?.maxSeconds ?? null;
    if (min !== null && total < min) {
      problems.push(`beats: total runtime ${total}s is under the brief's ${min}s minimum.`);
    }
    if (max !== null && total > max) {
      problems.push(`beats: total runtime ${total}s is over the brief's ${max}s maximum.`);
    }

    // An empty string is not silence. Null is.
    value.beats.forEach((beat, index) => {
      if (beat.voiceover !== null && beat.voiceover.trim() === "") {
        problems.push(`beats.${index}.voiceover: use null for a silent beat, not an empty string.`);
      }
      if (beat.onScreenText !== null && beat.onScreenText.trim() === "") {
        problems.push(`beats.${index}.onScreenText: use null for no text, not an empty string.`);
      }
    });

    const spoken = value.beats
      .map((beat) => `${beat.onScreenText ?? ""} ${beat.voiceover ?? ""} ${beat.shot}`)
      .join(" ");
    const haystack = normalise(spoken);

    for (const phrase of input.brand.bannedPhrases) {
      const needle = normalise(phrase);
      if (needle !== "" && haystack.includes(needle)) {
        problems.push(`beats: the treatment says the banned phrase "${phrase}".`);
      }
    }
    for (const topic of input.brand.prohibitedTopics) {
      const needle = normalise(topic);
      if (needle !== "" && haystack.includes(needle)) {
        problems.push(`beats: the treatment covers the prohibited topic "${topic}".`);
      }
    }

    // The delivery claim has to be supported by what was actually written.
    if (value.deliversKeyMessage) {
      if (!input.brief) {
        problems.push(
          "deliversKeyMessage: there is no brief and therefore no key message to deliver. Set it false.",
        );
      } else {
        const wanted = keywords(input.brief.keyMessage);
        const covered = wanted.filter((word) => haystack.includes(word));
        // Half the content words is a low bar deliberately — this catches a
        // treatment about something else entirely, not a paraphrase.
        if (wanted.length > 0 && covered.length * 2 < wanted.length) {
          problems.push(
            `deliversKeyMessage: no beat carries the key message "${input.brief.keyMessage}". Either write a beat that does, or set it false and say what is missing.`,
          );
        }
      }
    }

    if (input.brief?.hookFamily && value.hookFamily !== input.brief.hookFamily) {
      problems.push(
        `hookFamily: the brief commissioned "${input.brief.hookFamily}"; this says "${value.hookFamily}".`,
      );
    }

    return problems;
  },
});

export { CTA_PLACEMENTS };
