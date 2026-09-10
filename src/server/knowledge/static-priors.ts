import { Platform } from "@/generated/prisma/enums";
import type {
  ContentKnowledgeProvider,
  KnowledgeItem,
  KnowledgeQuery,
} from "./types";

/**
 * Cold-start priors.
 *
 * These are the assumptions the system starts from when a brand has published
 * nothing yet. They are deliberately few, deliberately general, and deliberately
 * low-confidence — a prior's job is to give a new account somewhere sensible to
 * begin and something specific to test, not to pretend to know the answer.
 *
 * Every item states a *direction* rather than a magnitude. Asserting "+31%
 * completion" from a shipped constant would be inventing account data, and the
 * weighting layer would treat it as a large measured effect. Where `effectSize`
 * is null the weighting layer applies a small assumed magnitude instead.
 *
 * As soon as the account produces its own observations, these are outweighed
 * automatically — not by a rule that says "prefer account evidence", but because
 * real observations carry sample size, measured effect and higher inferential
 * strength.
 */

const PRIORS: KnowledgeItem[] = [
  // --- Hooks ---------------------------------------------------------------
  {
    key: "hook-first-seconds",
    claim:
      "Stating the subject within the first two seconds tends to hold more viewers than a slow build.",
    dimension: "hook",
    groupKey: "direct",
    metric: "completionRate",
    confidence: 0.5,
    rationale:
      "Short-form feeds autoplay and are scrolled quickly, so the opening frame does the retention work.",
  },
  {
    key: "hook-problem-first",
    claim:
      "Naming the viewer's problem before the product is a reliable opening pattern for unaware audiences.",
    dimension: "hook",
    groupKey: "problem_solution",
    metric: "completionRate",
    confidence: 0.45,
    rationale:
      "A viewer who has not recognised the problem has no reason to care about the solution yet.",
  },
  {
    key: "hook-specific-number",
    claim:
      "A concrete number in the opening line tends to outperform a vague claim.",
    dimension: "hook",
    groupKey: "numeric",
    metric: "completionRate",
    confidence: 0.4,
    rationale: "Specificity reads as evidence; vagueness reads as marketing.",
  },
  {
    key: "hook-question-risk",
    claim:
      "Open questions can raise curiosity but risk a scroll if the answer is not implied quickly.",
    dimension: "hook",
    groupKey: "question",
    metric: "completionRate",
    confidence: 0.3,
    rationale:
      "A question defers the payoff, which is expensive in a feed optimised for immediate signal.",
  },

  // --- Length --------------------------------------------------------------
  {
    key: "length-short-completion",
    claim:
      "Shorter videos complete more often; longer ones can earn more watch time in total if they hold.",
    dimension: "length",
    groupKey: "0-15",
    metric: "completionRate",
    confidence: 0.5,
    rationale:
      "Completion is a ratio, so it falls with duration almost mechanically. Which matters depends on the objective.",
  },
  {
    key: "length-mid-balance",
    claim:
      "16–35 seconds is a common balance between completion and enough room to make a point.",
    dimension: "length",
    groupKey: "16-25",
    metric: "watchTimeSeconds",
    confidence: 0.35,
    rationale: "Long enough for one idea, short enough to finish.",
  },

  // --- Format --------------------------------------------------------------
  {
    key: "format-demo-proof",
    claim:
      "Showing the product working tends to drive more profile visits than describing it.",
    dimension: "format",
    groupKey: "SCREEN_RECORDING",
    metric: "profileVisits",
    confidence: 0.4,
    rationale: "Demonstration is self-evidencing in a way that claims are not.",
  },
  {
    key: "format-talking-head-trust",
    claim:
      "A visible person tends to help trust-led objectives more than pure screen capture.",
    dimension: "format",
    groupKey: "TALKING_HEAD",
    metric: "followerDelta",
    confidence: 0.35,
    rationale: "People follow people; faces carry more of a brand than interfaces do.",
  },

  // --- CTA -----------------------------------------------------------------
  {
    key: "cta-single-action",
    claim: "One clear action outperforms several competing asks.",
    dimension: "cta",
    groupKey: "single",
    metric: "linkClicks",
    confidence: 0.5,
    rationale: "Every additional option adds a decision, and decisions cost conversions.",
  },
  {
    key: "cta-comment-vs-link",
    claim:
      "Comment-based CTAs often lift engagement but move fewer people off-platform than a direct link.",
    dimension: "cta",
    groupKey: "comment",
    metric: "linkClicks",
    effectSize: null,
    confidence: 0.35,
    rationale:
      "Platforms reward on-platform actions; off-platform intent is a different behaviour.",
  },

  // --- Timing --------------------------------------------------------------
  {
    key: "timing-unknown-until-measured",
    claim:
      "Posting time effects are account-specific and should be measured rather than assumed.",
    dimension: "timing",
    groupKey: "unknown",
    metric: "views",
    confidence: 0.25,
    rationale:
      "Distribution depends on when this audience is active, which no general rule can know.",
  },

  // --- Cadence -------------------------------------------------------------
  {
    key: "cadence-consistency",
    claim:
      "Consistent cadence matters more than volume for building a measurable baseline.",
    dimension: "cadence",
    groupKey: "consistent",
    metric: "views",
    confidence: 0.45,
    rationale:
      "Irregular posting makes performance changes impossible to attribute to creative choices.",
  },
];

/**
 * TikTok-specific priors, layered on top of the platform-agnostic set above.
 */
const TIKTOK_PRIORS: KnowledgeItem[] = [
  {
    key: "tiktok-vertical-native",
    claim: "Native 9:16 without letterboxing is expected; cropped uploads read as reposts.",
    dimension: "format",
    groupKey: "aspect",
    metric: "views",
    confidence: 0.6,
    platform: Platform.TIKTOK,
    rationale: "The feed is full-screen vertical; anything else wastes the frame.",
  },
  {
    key: "tiktok-captions-on-mute",
    claim: "On-screen text matters because a large share of viewing starts muted.",
    dimension: "format",
    groupKey: "subtitles",
    metric: "completionRate",
    confidence: 0.55,
    platform: Platform.TIKTOK,
    rationale: "Audio-off viewing is common, so speech alone can carry nothing.",
  },
  {
    key: "tiktok-small-hashtag-set",
    claim: "A small relevant hashtag set is preferable to a large generic one.",
    dimension: "distribution",
    groupKey: "hashtags",
    metric: "views",
    confidence: 0.4,
    platform: Platform.TIKTOK,
    rationale:
      "Broad tags put content into pools it cannot compete in; specific tags reach smaller, better-matched audiences.",
  },
];

/**
 * The shipped prior provider.
 *
 * Deterministic and offline: the same query always returns the same items, so
 * cold-start behaviour is reproducible and testable without any external call.
 */
export const staticPriorProvider: ContentKnowledgeProvider = {
  name: "static-priors",
  kind: "STATIC_PRIOR",
  evidenceClass: "GLOBAL_PRIOR",
  enabled: true,
  description:
    "General short-form content priors shipped with the system. Assumptions to start from and test, not observations of any account.",

  async query(input: KnowledgeQuery): Promise<KnowledgeItem[]> {
    const pool = [...PRIORS, ...TIKTOK_PRIORS];

    return pool.filter((item) => {
      if (input.dimension && item.dimension !== input.dimension) return false;
      // Platform-specific priors only apply to their platform; agnostic ones
      // apply everywhere.
      if (item.platform && input.platform && item.platform !== input.platform) {
        return false;
      }
      if (input.objective && item.objective && item.objective !== input.objective) {
        return false;
      }
      return true;
    });
  },
};

/** Exposed for tests and the diagnostics view. */
export function allStaticPriors(): KnowledgeItem[] {
  return [...PRIORS, ...TIKTOK_PRIORS];
}
