/**
 * DEVELOPMENT FIXTURES — NOT PRODUCTION DATA.
 *
 * Every value in this file is invented so the standalone frontend is usable
 * without a backend. Nothing here describes a real client, a real campaign, or
 * a real marketing result. The UI surfaces this via `Workspace.isDemoData` and
 * `AnalyticsSummary.isDemoData`, which render an explicit "demo dataset" badge.
 *
 * All timestamps derive from DEMO_NOW so renders are deterministic and never
 * cause hydration mismatches between server and client.
 */

import { addDays, addHours, formatISO, startOfWeek } from "date-fns";

import type {
  ActivityEvent,
  AnalyticsSeries,
  BestPostingTime,
  BrandProfile,
  Client,
  ContentBrief,
  ContentIdea,
  ContentItem,
  ContentPillar,
  ContentStatus,
  GenerationJob,
  IntegrationProvider,
  LearningInsight,
  MediaAsset,
  MetricValue,
  PillarPerformance,
  PlanHistoryEntry,
  PlannedBrief,
  Platform,
  ScriptDraft,
  ScriptVariant,
  TopContentRow,
} from "@/lib/social-scales/contracts";

/** Fixed anchor: Thursday 10 September 2026, 09:00 local. */
export const DEMO_NOW = new Date(2026, 8, 10, 9, 0, 0);

export const DEMO_WEEK_START = startOfWeek(DEMO_NOW, { weekStartsOn: 1 });

const iso = (d: Date) => formatISO(d);

/** Deterministic pseudo-random generator so charts look organic but never move. */
export function seeded(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/* -------------------------------------------------------------------------- */
/* Workspace + brand                                                          */
/* -------------------------------------------------------------------------- */

export const DEMO_WORKSPACE = {
  id: "ws_social_scales",
  name: "Social Scales",
  tagline: "Ideas. Systems. Content. Customers.",
  plan: "Agency",
  ownerName: "Alex Carter",
  ownerRole: "Agency Owner",
  isDemoData: true,
};

export const DEMO_BRAND_PROFILE: BrandProfile = {
  businessName: "ClipPilot AI",
  website: "https://clippilot.ai",
  niche: "AI Tools & Technology",
  offer:
    "AI content systems for creators and brands. We script, edit, post and scale short-form content.",
  productsServices: ["Done-for-you short form", "Content system setup", "Monthly strategy"],
  idealCustomer:
    "Creators, coaches and small business owners who want to grow on social media but do not have time to create content.",
  businessObjective: "Generate leads and customers",
  contentGoals: ["Grow audience", "Build authority", "Drive booked calls"],
  primaryCta: "Book a free strategy call",
  toneOfVoice: ["Direct", "Practical", "Confident"],
  phrasesToUse: ["content system", "turn attention into customers", "same platform, bigger possibilities"],
  claimsToAvoid: ["guaranteed results", "get rich quick", "overnight growth"],
  competitors: ["@growthinpublic", "@shortformlab"],
  platforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE", "LINKEDIN"],
  postingFrequency: "3-5 times per week",
  existingSocialLinks: ["https://tiktok.com/@clippilot", "https://instagram.com/clippilot"],
  assetAvailability: "SOME",
  approvalPreference: "REVIEW_EVERYTHING",
};

/* -------------------------------------------------------------------------- */
/* Clients                                                                    */
/* -------------------------------------------------------------------------- */

export const DEMO_CLIENTS: Client[] = [
  {
    id: "cl_clippilot",
    name: "ClipPilot AI",
    initials: "CP",
    niche: "AI Tools & Technology",
    status: "ACTIVE",
    onboardingComplete: true,
    connectedPlatforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE", "LINKEDIN"],
    planStatus: "ACTIVE",
    postsThisWeek: 12,
    awaitingApproval: 3,
    upcomingPosts: 6,
    engagementTrendPct: 34,
    health: "HEALTHY",
    lastActivityAt: iso(addHours(DEMO_NOW, -1)),
  },
  {
    id: "cl_elevate",
    name: "Elevate Co.",
    initials: "EC",
    niche: "Business Coaching",
    status: "ACTIVE",
    onboardingComplete: true,
    connectedPlatforms: ["TIKTOK", "INSTAGRAM"],
    planStatus: "ACTIVE",
    postsThisWeek: 10,
    awaitingApproval: 1,
    upcomingPosts: 4,
    engagementTrendPct: 22,
    health: "HEALTHY",
    lastActivityAt: iso(addHours(DEMO_NOW, -5)),
  },
  {
    id: "cl_peak",
    name: "Peak Studio",
    initials: "PS",
    niche: "Design Studio",
    status: "ACTIVE",
    onboardingComplete: true,
    connectedPlatforms: ["INSTAGRAM", "LINKEDIN"],
    planStatus: "AWAITING_APPROVAL",
    postsThisWeek: 8,
    awaitingApproval: 4,
    upcomingPosts: 3,
    engagementTrendPct: 11,
    health: "ATTENTION",
    lastActivityAt: iso(addHours(DEMO_NOW, -9)),
  },
  {
    id: "cl_nexa",
    name: "Nexa Fitness",
    initials: "NF",
    niche: "Fitness & Wellness",
    status: "ACTIVE",
    onboardingComplete: true,
    connectedPlatforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE"],
    planStatus: "ACTIVE",
    postsThisWeek: 12,
    awaitingApproval: 0,
    upcomingPosts: 5,
    engagementTrendPct: 18,
    health: "HEALTHY",
    lastActivityAt: iso(addHours(DEMO_NOW, -26)),
  },
  {
    id: "cl_lumen",
    name: "Lumen Brand",
    initials: "LB",
    niche: "E-commerce",
    status: "ONBOARDING",
    onboardingComplete: false,
    connectedPlatforms: [],
    planStatus: "DRAFT",
    postsThisWeek: 0,
    awaitingApproval: 0,
    upcomingPosts: 0,
    engagementTrendPct: null,
    health: "ATTENTION",
    lastActivityAt: iso(addHours(DEMO_NOW, -48)),
  },
  {
    id: "cl_northline",
    name: "Northline Legal",
    initials: "NL",
    niche: "Professional Services",
    status: "PAUSED",
    onboardingComplete: true,
    connectedPlatforms: ["LINKEDIN"],
    planStatus: "COMPLETED",
    postsThisWeek: 0,
    awaitingApproval: 0,
    upcomingPosts: 0,
    engagementTrendPct: -6,
    health: "AT_RISK",
    lastActivityAt: iso(addDays(DEMO_NOW, -12)),
  },
];

export const PRIMARY_CLIENT_ID = "cl_clippilot";

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

export const DEMO_PILLARS: ContentPillar[] = [
  {
    id: "pil_automation",
    name: "Automation Proof",
    description: "Show the system doing the work. Screen recordings, before/after, real output.",
    sharePct: 35,
    colorToken: "accent",
  },
  {
    id: "pil_pain",
    name: "Business Pain",
    description: "Name the expensive problem the buyer already feels every week.",
    sharePct: 25,
    colorToken: "violet",
  },
  {
    id: "pil_build",
    name: "Build In Public",
    description: "Progress, numbers, mistakes. Builds trust and repeat viewers.",
    sharePct: 20,
    colorToken: "ok",
  },
  {
    id: "pil_authority",
    name: "Authority & Teardown",
    description: "Frameworks and teardowns that position us as the operator, not the vendor.",
    sharePct: 20,
    colorToken: "info",
  },
];

const briefDay = (offset: number, hour: number) => addHours(addDays(DEMO_WEEK_START, offset), hour);

export const DEMO_BRIEFS: PlannedBrief[] = [
  {
    id: "br_1",
    dayLabel: "Mon",
    scheduledFor: iso(briefDay(0, 8)),
    platform: "TIKTOK",
    pillarId: "pil_pain",
    title: "Businesses are still making content by hand",
    angle: "Open on the cost of manual content, close on the system.",
    status: "PUBLISHED",
  },
  {
    id: "br_2",
    dayLabel: "Mon",
    scheduledFor: iso(briefDay(0, 16)),
    platform: "LINKEDIN",
    pillarId: "pil_authority",
    title: "The four-step content system we run for every client",
    angle: "Framework post. No video required.",
    status: "PUBLISHED",
  },
  {
    id: "br_3",
    dayLabel: "Tue",
    scheduledFor: iso(briefDay(1, 8)),
    platform: "YOUTUBE",
    pillarId: "pil_automation",
    title: "AI tools series: from idea to posted in 9 minutes",
    angle: "Screen recording with captions, no talking head.",
    status: "PUBLISHED",
  },
  {
    id: "br_4",
    dayLabel: "Tue",
    scheduledFor: iso(briefDay(1, 10)),
    platform: "INSTAGRAM",
    pillarId: "pil_build",
    title: "Productivity hack we actually use",
    angle: "Fast cuts, one idea, strong caption.",
    status: "PUBLISHED",
  },
  {
    id: "br_5",
    dayLabel: "Wed",
    scheduledFor: iso(briefDay(2, 8)),
    platform: "LINKEDIN",
    pillarId: "pil_authority",
    title: "Client results teardown",
    angle: "What changed, what we measured, what we would do differently.",
    status: "PUBLISHED",
  },
  {
    id: "br_6",
    dayLabel: "Wed",
    scheduledFor: iso(briefDay(2, 10)),
    platform: "TIKTOK",
    pillarId: "pil_automation",
    title: "Scale faster without hiring an editor",
    angle: "Problem-first hook, demo body, soft CTA.",
    status: "SCHEDULED",
  },
  {
    id: "br_7",
    dayLabel: "Thu",
    scheduledFor: iso(briefDay(3, 8)),
    platform: "TIKTOK",
    pillarId: "pil_pain",
    title: "3 tips for growth that actually compound",
    angle: "Listicle with a contrarian third point.",
    status: "NEEDS_REVIEW",
  },
  {
    id: "br_8",
    dayLabel: "Thu",
    scheduledFor: iso(briefDay(3, 12)),
    platform: "YOUTUBE",
    pillarId: "pil_automation",
    title: "Use AI like a pro, not like a toy",
    angle: "Show the prompt, show the output, show the edit.",
    status: "GENERATING",
  },
  {
    id: "br_9",
    dayLabel: "Fri",
    scheduledFor: iso(briefDay(4, 8)),
    platform: "INSTAGRAM",
    pillarId: "pil_build",
    title: "Behind the scenes at Social Scales",
    angle: "Studio footage, honest voiceover.",
    status: "APPROVED",
  },
  {
    id: "br_10",
    dayLabel: "Sat",
    scheduledFor: iso(briefDay(5, 12)),
    platform: "TIKTOK",
    pillarId: "pil_authority",
    title: "Industry insights: what changed this month",
    angle: "Short commentary on a real platform change.",
    status: "SCRIPT",
  },
  {
    id: "br_11",
    dayLabel: "Sun",
    scheduledFor: iso(briefDay(6, 10)),
    platform: "LINKEDIN",
    pillarId: "pil_build",
    title: "Team culture and how we run the week",
    angle: "Written post, one image.",
    status: "IDEA",
  },
];

export const DEMO_PLAN_HISTORY: PlanHistoryEntry[] = [
  {
    id: "ph_w36",
    label: "Week 36",
    periodStart: iso(addDays(DEMO_WEEK_START, -7)),
    periodEnd: iso(addDays(DEMO_WEEK_START, -1)),
    adherencePct: 91,
    postsPublished: 10,
    headline: "Problem-first hooks held retention longest.",
  },
  {
    id: "ph_w35",
    label: "Week 35",
    periodStart: iso(addDays(DEMO_WEEK_START, -14)),
    periodEnd: iso(addDays(DEMO_WEEK_START, -8)),
    adherencePct: 76,
    postsPublished: 8,
    headline: "Two briefs skipped: no raw footage available.",
  },
  {
    id: "ph_w34",
    label: "Week 34",
    periodStart: iso(addDays(DEMO_WEEK_START, -21)),
    periodEnd: iso(addDays(DEMO_WEEK_START, -15)),
    adherencePct: 83,
    postsPublished: 9,
    headline: "First week the automation pillar out-performed authority.",
  },
];

/* -------------------------------------------------------------------------- */
/* Ideas, briefs, scripts, assets                                             */
/* -------------------------------------------------------------------------- */

export const DEMO_IDEAS: ContentIdea[] = [
  {
    id: "idea_1",
    clientId: PRIMARY_CLIENT_ID,
    title: "How automation saves you 10+ hours a week",
    rationale: "High engagement potential — time-saving hooks are the strongest performer this month.",
    pillarId: "pil_automation",
    platform: "TIKTOK",
    source: "FOR_YOU",
    potential: "HIGH",
    thumbnailTone: "cyan",
    createdAt: iso(addHours(DEMO_NOW, -2)),
  },
  {
    id: "idea_2",
    clientId: PRIMARY_CLIENT_ID,
    title: "3 signs your brand needs short-form video",
    rationale: "Trending in your niche — diagnostic listicles are being reshared heavily.",
    pillarId: "pil_pain",
    platform: "TIKTOK",
    source: "TRENDING",
    potential: "HIGH",
    thumbnailTone: "violet",
    createdAt: iso(addHours(DEMO_NOW, -3)),
  },
  {
    id: "idea_3",
    clientId: PRIMARY_CLIENT_ID,
    title: "Behind the scenes: a day at Social Scales",
    rationale: "Builds trust and brand authority. Cheap to produce from existing footage.",
    pillarId: "pil_build",
    platform: "INSTAGRAM",
    source: "FOR_YOU",
    potential: "MEDIUM",
    thumbnailTone: "teal",
    createdAt: iso(addHours(DEMO_NOW, -5)),
  },
  {
    id: "idea_4",
    clientId: PRIMARY_CLIENT_ID,
    title: "From 0 to 10K followers (the real strategy)",
    rationale: "Proven framework content. Works as a carousel and a video.",
    pillarId: "pil_authority",
    platform: "YOUTUBE",
    source: "CLIENT_GOALS",
    potential: "MEDIUM",
    thumbnailTone: "indigo",
    createdAt: iso(addHours(DEMO_NOW, -7)),
  },
  {
    id: "idea_5",
    clientId: PRIMARY_CLIENT_ID,
    title: "The biggest mistake brands make on TikTok",
    rationale: "High discussion potential. Expect comment volume rather than shares.",
    pillarId: "pil_pain",
    platform: "TIKTOK",
    source: "TRENDING",
    potential: "EXPLORATORY",
    thumbnailTone: "amber",
    createdAt: iso(addHours(DEMO_NOW, -9)),
  },
  {
    id: "idea_6",
    clientId: PRIMARY_CLIENT_ID,
    title: "We tried posting daily for 30 days. Here is the data.",
    rationale: "Saved by you. Needs real numbers before it can be scripted.",
    pillarId: "pil_build",
    platform: "TIKTOK",
    source: "SAVED",
    potential: "MEDIUM",
    thumbnailTone: "slate",
    createdAt: iso(addDays(DEMO_NOW, -2)),
  },
];

export const DEMO_BRIEF: ContentBrief = {
  id: "cb_1",
  ideaId: "idea_1",
  problem: "Creators and brands spend hours every week on ideation, scripting, editing and posting.",
  transformation:
    "A content system takes the same raw ideas and turns them into scheduled, on-brand posts in a fraction of the time.",
  proofPoint: "Show the pipeline running end to end on screen, no narration required.",
  callToAction: "Follow for more, or book a free strategy call.",
  targetDurationSec: 45,
};

export const DEMO_SCRIPT: ScriptDraft = {
  id: "sc_1",
  contentItemId: "ci_1",
  workingTitle: "How Automation Saves You 10+ Hours a Week",
  hook: "You are probably spending hours on content, when a system could be doing it for you.",
  body: "Most creators and brands lose the week to idea generation, scripting, editing and posting.\n\nAt Social Scales we run one system: your ideas go in, briefs and scripts come out, the edit is assembled, and the post is scheduled to the platforms you actually use.\n\nSame effort at the start. Far more output at the end.",
  cta: "Ready to scale your content? Follow for more, or book a free strategy call at Social Scales.",
  hookWindowSec: [0, 3],
  bodyWindowSec: [4, 45],
  ctaWindowSec: [46, 60],
  generatedBy: "AI",
  updatedAt: iso(addHours(DEMO_NOW, -1)),
};

export const DEMO_VARIANTS: ScriptVariant[] = [
  { id: "v1", label: "Hook Focus", angle: "Lead with the time cost, cut the setup.", selected: true },
  { id: "v2", label: "Educational", angle: "Walk through the four stages of the system.", selected: false },
  { id: "v3", label: "Behind the Scenes", angle: "Narrate over real screen recording.", selected: false },
  { id: "v4", label: "Testimonial", angle: "Frame around a client outcome.", selected: false },
];

export const DEMO_ASSETS: MediaAsset[] = [
  {
    id: "as_1",
    clientId: PRIMARY_CLIENT_ID,
    fileName: "studio_broll.mp4",
    kind: "VIDEO",
    durationSec: 12,
    thumbnailTone: "slate",
    selected: false,
    addedAt: iso(addDays(DEMO_NOW, -3)),
  },
  {
    id: "as_2",
    clientId: PRIMARY_CLIENT_ID,
    fileName: "ai_workflow.jpg",
    kind: "IMAGE",
    durationSec: null,
    thumbnailTone: "cyan",
    selected: true,
    addedAt: iso(addDays(DEMO_NOW, -3)),
  },
  {
    id: "as_3",
    clientId: PRIMARY_CLIENT_ID,
    fileName: "team_meeting.mp4",
    kind: "VIDEO",
    durationSec: 28,
    thumbnailTone: "indigo",
    selected: false,
    addedAt: iso(addDays(DEMO_NOW, -4)),
  },
  {
    id: "as_4",
    clientId: PRIMARY_CLIENT_ID,
    fileName: "growth_graph.png",
    kind: "GRAPHIC",
    durationSec: null,
    thumbnailTone: "teal",
    selected: false,
    addedAt: iso(addDays(DEMO_NOW, -6)),
  },
  {
    id: "as_5",
    clientId: PRIMARY_CLIENT_ID,
    fileName: "creator_desk.jpg",
    kind: "IMAGE",
    durationSec: null,
    thumbnailTone: "violet",
    selected: false,
    addedAt: iso(addDays(DEMO_NOW, -6)),
  },
  {
    id: "as_6",
    clientId: PRIMARY_CLIENT_ID,
    fileName: "phone_mockup.mp4",
    kind: "VIDEO",
    durationSec: 15,
    thumbnailTone: "amber",
    selected: false,
    addedAt: iso(addDays(DEMO_NOW, -8)),
  },
  {
    id: "as_7",
    clientId: PRIMARY_CLIENT_ID,
    fileName: "mountain_bg.jpg",
    kind: "IMAGE",
    durationSec: null,
    thumbnailTone: "slate",
    selected: false,
    addedAt: iso(addDays(DEMO_NOW, -10)),
  },
  {
    id: "as_8",
    clientId: PRIMARY_CLIENT_ID,
    fileName: "brand_kit_v3.pdf",
    kind: "BRAND_KIT",
    durationSec: null,
    thumbnailTone: "cyan",
    selected: false,
    addedAt: iso(addDays(DEMO_NOW, -14)),
  },
];

export const DEMO_CAPTION_STYLES = [
  { id: "cs_modern", label: "Modern Bold", description: "Heavy sans, high contrast, word-by-word reveal." },
  { id: "cs_minimal", label: "Minimal", description: "Small caps, single line, bottom third." },
  { id: "cs_neon", label: "Neon Glow", description: "Accent glow on the active word." },
  { id: "cs_cinematic", label: "Cinematic", description: "Letterboxed, centred, slow fade." },
  { id: "cs_subtle", label: "Subtle", description: "Low-opacity backing plate, no animation." },
  { id: "cs_brand", label: "Brand", description: "Uses the client brand kit typography." },
];

/* -------------------------------------------------------------------------- */
/* Content items                                                              */
/* -------------------------------------------------------------------------- */

const job = (
  id: string,
  status: GenerationJob["status"],
  progress: number,
  overrides: Partial<GenerationJob> = {},
): GenerationJob => ({
  generationJobId: `gj_${id}`,
  contentItemId: id,
  status,
  progress,
  previewUrl: null,
  finalVideoUrl: null,
  thumbnailUrl: null,
  qaStatus: status === "READY" ? "PASSED" : "PENDING",
  failureReason: null,
  createdAt: iso(addHours(DEMO_NOW, -2)),
  completedAt: status === "READY" ? iso(addHours(DEMO_NOW, -1)) : null,
  ...overrides,
});

interface ItemSeed {
  id: string;
  title: string;
  hook: string;
  platform: Platform;
  pillarId: string;
  status: ContentStatus;
  clientId?: string;
  dayOffset?: number;
  hour?: number;
  duration?: number | null;
  tone: string;
  generation?: GenerationJob | null;
}

const ITEM_SEEDS: ItemSeed[] = [
  {
    id: "ci_1",
    title: "How Automation Saves You 10+ Hours a Week",
    hook: "You are probably spending hours on content, when a system could be doing it for you.",
    platform: "TIKTOK",
    pillarId: "pil_automation",
    status: "NEEDS_REVIEW",
    dayOffset: 3,
    hour: 8,
    duration: 47,
    tone: "cyan",
    generation: job("ci_1", "READY", 100, {
      qaStatus: "PASSED",
      thumbnailUrl: null,
    }),
  },
  {
    id: "ci_2",
    title: "3 Signs Your Brand Needs Short-Form Video",
    hook: "If any of these three things are true, short form is already costing you money.",
    platform: "TIKTOK",
    pillarId: "pil_pain",
    status: "GENERATING",
    dayOffset: 3,
    hour: 12,
    duration: 38,
    tone: "violet",
    generation: job("ci_2", "RENDERING", 64),
  },
  {
    id: "ci_3",
    title: "Behind the Scenes at Social Scales",
    hook: "This is what a week inside a content system actually looks like.",
    platform: "INSTAGRAM",
    pillarId: "pil_build",
    status: "APPROVED",
    dayOffset: 4,
    hour: 8,
    duration: 31,
    tone: "teal",
  },
  {
    id: "ci_4",
    title: "Use AI Like a Pro, Not Like a Toy",
    hook: "Most people prompt. Operators build systems.",
    platform: "YOUTUBE",
    pillarId: "pil_automation",
    status: "SCHEDULED",
    dayOffset: 3,
    hour: 12,
    duration: 58,
    tone: "indigo",
  },
  {
    id: "ci_5",
    title: "Scale Faster Without Hiring an Editor",
    hook: "An editor costs you a salary. A system costs you an afternoon.",
    platform: "TIKTOK",
    pillarId: "pil_automation",
    status: "SCHEDULED",
    dayOffset: 2,
    hour: 10,
    duration: 41,
    tone: "cyan",
  },
  {
    id: "ci_6",
    title: "Client Results Teardown",
    hook: "Here is exactly what we changed, and what it actually moved.",
    platform: "LINKEDIN",
    pillarId: "pil_authority",
    status: "PUBLISHED",
    dayOffset: 2,
    hour: 8,
    duration: null,
    tone: "slate",
  },
  {
    id: "ci_7",
    title: "Productivity Hack for Creators",
    hook: "Batch once. Post for two weeks.",
    platform: "INSTAGRAM",
    pillarId: "pil_build",
    status: "PUBLISHED",
    dayOffset: 1,
    hour: 10,
    duration: 22,
    tone: "amber",
    clientId: "cl_elevate",
  },
  {
    id: "ci_8",
    title: "AI Tools Series: Idea to Posted in 9 Minutes",
    hook: "One idea. Nine minutes. Fully scheduled.",
    platform: "YOUTUBE",
    pillarId: "pil_automation",
    status: "PUBLISHED",
    dayOffset: 1,
    hour: 8,
    duration: 63,
    tone: "indigo",
  },
  {
    id: "ci_9",
    title: "Industry Insights: What Changed This Month",
    hook: "Two platform changes that quietly affect your reach.",
    platform: "TIKTOK",
    pillarId: "pil_authority",
    status: "SCRIPT",
    dayOffset: 5,
    hour: 12,
    duration: null,
    tone: "violet",
  },
  {
    id: "ci_10",
    title: "Team Culture and How We Run the Week",
    hook: "The meeting that replaced four meetings.",
    platform: "LINKEDIN",
    pillarId: "pil_build",
    status: "IDEA",
    dayOffset: 6,
    hour: 10,
    duration: null,
    tone: "slate",
  },
  {
    id: "ci_11",
    title: "Before vs After: The Same Brand, One Month Apart",
    hook: "Same product. Same founder. Different system.",
    platform: "TIKTOK",
    pillarId: "pil_pain",
    status: "NEEDS_REVIEW",
    dayOffset: 0,
    hour: 16,
    duration: 29,
    tone: "cyan",
    clientId: "cl_peak",
    generation: job("ci_11", "READY", 100),
  },
  {
    id: "ci_12",
    title: "Common Content Mistakes",
    hook: "Four mistakes that cap your reach before the algorithm gets involved.",
    platform: "INSTAGRAM",
    pillarId: "pil_pain",
    status: "NEEDS_REVIEW",
    dayOffset: 3,
    hour: 16,
    duration: 34,
    tone: "amber",
    clientId: "cl_peak",
    generation: job("ci_12", "READY", 100, { qaStatus: "FLAGGED" }),
  },
  {
    id: "ci_13",
    title: "Client Testimonial: Elevate Co.",
    hook: "They stopped posting manually in week one.",
    platform: "LINKEDIN",
    pillarId: "pil_authority",
    status: "APPROVED",
    dayOffset: 0,
    hour: 12,
    duration: null,
    tone: "teal",
    clientId: "cl_elevate",
  },
  {
    id: "ci_14",
    title: "Weekly Recap: What We Shipped",
    hook: "Five posts, one system, zero late nights.",
    platform: "TIKTOK",
    pillarId: "pil_build",
    status: "SCHEDULED",
    dayOffset: 6,
    hour: 16,
    duration: 26,
    tone: "cyan",
    clientId: "cl_nexa",
  },
  {
    id: "ci_15",
    title: "Success Story: Nexa Fitness",
    hook: "From four posts a month to twelve, without adding headcount.",
    platform: "LINKEDIN",
    pillarId: "pil_authority",
    status: "SCHEDULED",
    dayOffset: 5,
    hour: 16,
    duration: null,
    tone: "indigo",
    clientId: "cl_nexa",
  },
  {
    id: "ci_16",
    title: "Dream Bigger Motivation Cut",
    hook: "The version of your brand you keep postponing.",
    platform: "TIKTOK",
    pillarId: "pil_build",
    status: "FAILED",
    dayOffset: 2,
    hour: 18,
    duration: null,
    tone: "slate",
    generation: job("ci_16", "FAILED", 41, {
      qaStatus: "FAILED",
      failureReason: "Source clip shorter than the requested 30s cut.",
      completedAt: iso(addHours(DEMO_NOW, -4)),
    }),
  },
  {
    id: "ci_17",
    title: "Q&A: The Question We Get Every Week",
    hook: "Does this work if I have no footage at all?",
    platform: "YOUTUBE",
    pillarId: "pil_pain",
    status: "ASSET_READY",
    dayOffset: 4,
    hour: 10,
    duration: null,
    tone: "violet",
  },
  {
    id: "ci_18",
    title: "The Four-Step Content System",
    hook: "Plan, produce, publish, learn. That is the whole thing.",
    platform: "LINKEDIN",
    pillarId: "pil_authority",
    status: "PUBLISHED",
    dayOffset: 0,
    hour: 16,
    duration: null,
    tone: "teal",
  },
  {
    id: "ci_19",
    title: "Businesses Are Still Making Content by Hand",
    hook: "In 2026. By hand. Every single week.",
    platform: "TIKTOK",
    pillarId: "pil_pain",
    status: "PUBLISHED",
    dayOffset: 0,
    hour: 8,
    duration: 33,
    tone: "cyan",
  },
  {
    id: "ci_20",
    title: "Evening Tip: Repurpose Before You Create",
    hook: "You already made this. You just never cut it up.",
    platform: "INSTAGRAM",
    pillarId: "pil_build",
    status: "BRIEF",
    dayOffset: 0,
    hour: 18,
    duration: null,
    tone: "amber",
  },
];

export const DEMO_CONTENT_ITEMS: ContentItem[] = ITEM_SEEDS.map((seed) => {
  const clientId = seed.clientId ?? PRIMARY_CLIENT_ID;
  const client = DEMO_CLIENTS.find((c) => c.id === clientId);
  const plannedPublishAt =
    seed.dayOffset === undefined
      ? null
      : iso(addHours(addDays(DEMO_WEEK_START, seed.dayOffset), seed.hour ?? 9));

  return {
    id: seed.id,
    clientId,
    clientName: client?.name ?? "Unknown client",
    title: seed.title,
    hook: seed.hook,
    platform: seed.platform,
    pillarId: seed.pillarId,
    status: seed.status,
    generation: seed.generation ?? null,
    plannedPublishAt,
    durationSec: seed.duration ?? null,
    assetIds: seed.id === "ci_1" ? ["as_2", "as_1"] : [],
    approvalRequired: seed.status === "NEEDS_REVIEW",
    thumbnailTone: seed.tone,
    updatedAt: iso(addHours(DEMO_NOW, -(ITEM_SEEDS.indexOf(seed) + 1))),
  };
});

/* -------------------------------------------------------------------------- */
/* Activity, insights, analytics                                              */
/* -------------------------------------------------------------------------- */

export const DEMO_ACTIVITY: ActivityEvent[] = [
  { id: "ac_1", kind: "IDEA", message: "Generated 10 new content ideas for ClipPilot AI", occurredAt: iso(addHours(DEMO_NOW, -0.05)) },
  { id: "ac_2", kind: "SCRIPT", message: 'Script created: "3 Reasons You Need This"', occurredAt: iso(addHours(DEMO_NOW, -0.2)) },
  { id: "ac_3", kind: "SCHEDULE", message: "Video scheduled for Friday, 10:00", occurredAt: iso(addHours(DEMO_NOW, -1)) },
  { id: "ac_4", kind: "REPORT", message: "Weekly performance report updated", occurredAt: iso(addHours(DEMO_NOW, -3)) },
  { id: "ac_5", kind: "CLIENT", message: 'Client "Lumen Brand" added and onboarding started', occurredAt: iso(addHours(DEMO_NOW, -5)) },
  { id: "ac_6", kind: "OPTIMISATION", message: "Re-cut 4 underperforming posts with stronger hooks", occurredAt: iso(addHours(DEMO_NOW, -8)) },
  { id: "ac_7", kind: "PUBLISH", message: 'Published "Client Results Teardown" to LinkedIn', occurredAt: iso(addHours(DEMO_NOW, -22)) },
];

export const DEMO_INSIGHTS: LearningInsight[] = [
  {
    id: "in_1",
    headline: "Problem-first hooks held retention longest",
    detail:
      "In this demo dataset, posts that opened by naming a cost or a mistake retained 31% more viewers past the three-second mark than posts that opened with a claim.",
    confidence: "STRONG",
    appliesToNextPlan: true,
  },
  {
    id: "in_2",
    headline: "Videos between 13 and 18 seconds performed best",
    detail:
      "Completion rate falls off sharply past 20 seconds on TikTok in this dataset. Longer cuts still work on YouTube.",
    confidence: "EMERGING",
    appliesToNextPlan: true,
  },
  {
    id: "in_3",
    headline: "Automation demos drove the most profile visits",
    detail:
      "Screen-recorded demonstrations converted viewers into profile visits at roughly twice the rate of talking-head posts.",
    confidence: "STRONG",
    appliesToNextPlan: true,
  },
  {
    id: "in_4",
    headline: "Thursday posts outperformed Monday posts",
    detail: "Thursday 08:00 is the strongest slot in this dataset. Monday mornings underperform consistently.",
    confidence: "OBSERVED",
    appliesToNextPlan: false,
  },
  {
    id: "in_5",
    headline: "Adding captions increased retention",
    detail: "Captioned cuts retained about 42% more viewers to the halfway point than uncaptioned cuts.",
    confidence: "EMERGING",
    appliesToNextPlan: true,
  },
];

function series(key: string, label: string, seed: number, base: number, drift: number, days: number): AnalyticsSeries {
  const rand = seeded(seed);
  const points = Array.from({ length: days }, (_, i) => {
    const wobble = (rand() - 0.45) * base * 0.28;
    return {
      date: iso(addDays(DEMO_NOW, -(days - 1 - i))).slice(0, 10),
      value: Math.max(0, Math.round(base + drift * i + wobble)),
    };
  });
  return { key, label, points };
}

export function demoSeries(days: number): AnalyticsSeries[] {
  return [
    series("views", "Views", 11, 26000, 900, days),
    series("engagements", "Engagements", 23, 1900, 70, days),
    series("profileVisits", "Profile visits", 37, 1250, 44, days),
    series("conversions", "Conversions", 53, 82, 3, days),
  ];
}

export const DEMO_HEADLINE_METRICS: MetricValue[] = [
  { key: "views", label: "Total views", value: 248300, format: "COUNT", deltaPct: 42 },
  { key: "engagements", label: "Engagements", value: 18600, format: "COUNT", deltaPct: 68 },
  { key: "profileVisits", label: "Profile visits", value: 12400, format: "COUNT", deltaPct: 55 },
  { key: "conversions", label: "Conversions", value: 842, format: "COUNT", deltaPct: 88 },
];

export const DEMO_SECONDARY_METRICS: MetricValue[] = [
  { key: "watchTime", label: "Avg. watch time", value: 14, format: "DURATION_SEC", deltaPct: 12 },
  { key: "completion", label: "Completion rate", value: 47, format: "PERCENT", deltaPct: 9 },
  { key: "shares", label: "Shares", value: 3120, format: "COUNT", deltaPct: 31 },
  { key: "saves", label: "Saves", value: 2480, format: "COUNT", deltaPct: 28 },
  { key: "comments", label: "Comments", value: 1640, format: "COUNT", deltaPct: 17 },
  { key: "follows", label: "New follows", value: 4310, format: "COUNT", deltaPct: 24 },
  { key: "clicks", label: "Link clicks", value: 1980, format: "COUNT", deltaPct: 36 },
  { key: "postsPublished", label: "Posts published", value: 124, format: "COUNT", deltaPct: 48 },
];

export const DEMO_DASHBOARD_METRICS: MetricValue[] = [
  { key: "scheduled", label: "Posts scheduled", value: 124, format: "COUNT", deltaPct: 48 },
  { key: "drafts", label: "Drafts generated", value: 317, format: "COUNT", deltaPct: 62 },
  { key: "engagementLift", label: "Engagement lift", value: 34, format: "PERCENT", deltaPct: 34 },
  { key: "activeClients", label: "Active clients", value: 8, format: "COUNT", deltaPct: 33 },
];

export const DEMO_TOP_CONTENT: TopContentRow[] = [
  {
    contentItemId: "ci_19",
    title: "Businesses Are Still Making Content by Hand",
    platform: "TIKTOK",
    publishedAt: iso(addDays(DEMO_NOW, -4)),
    views: 42800,
    engagementRatePct: 9.4,
    completionRatePct: 61,
    pillarId: "pil_pain",
  },
  {
    contentItemId: "ci_8",
    title: "AI Tools Series: Idea to Posted in 9 Minutes",
    platform: "YOUTUBE",
    publishedAt: iso(addDays(DEMO_NOW, -3)),
    views: 31200,
    engagementRatePct: 7.8,
    completionRatePct: 54,
    pillarId: "pil_automation",
  },
  {
    contentItemId: "ci_6",
    title: "Client Results Teardown",
    platform: "LINKEDIN",
    publishedAt: iso(addDays(DEMO_NOW, -2)),
    views: 18400,
    engagementRatePct: 11.2,
    completionRatePct: 48,
    pillarId: "pil_authority",
  },
  {
    contentItemId: "ci_7",
    title: "Productivity Hack for Creators",
    platform: "INSTAGRAM",
    publishedAt: iso(addDays(DEMO_NOW, -3)),
    views: 16900,
    engagementRatePct: 6.1,
    completionRatePct: 52,
    pillarId: "pil_build",
  },
  {
    contentItemId: "ci_18",
    title: "The Four-Step Content System",
    platform: "LINKEDIN",
    publishedAt: iso(addDays(DEMO_NOW, -5)),
    views: 14200,
    engagementRatePct: 8.7,
    completionRatePct: 44,
    pillarId: "pil_authority",
  },
];

export const DEMO_PILLAR_PERFORMANCE: PillarPerformance[] = [
  { pillarId: "pil_automation", pillarName: "Automation Proof", posts: 14, avgViews: 24100, engagementRatePct: 8.4 },
  { pillarId: "pil_pain", pillarName: "Business Pain", posts: 11, avgViews: 27600, engagementRatePct: 9.1 },
  { pillarId: "pil_build", pillarName: "Build In Public", posts: 9, avgViews: 15200, engagementRatePct: 6.2 },
  { pillarId: "pil_authority", pillarName: "Authority & Teardown", posts: 8, avgViews: 16800, engagementRatePct: 9.8 },
];

const BEST_TIME_SEED: Array<[string, string, number, boolean]> = [
  ["Mon", "09:00", 58, false],
  ["Tue", "11:00", 64, false],
  ["Wed", "08:00", 71, false],
  ["Thu", "08:00", 94, true],
  ["Fri", "10:00", 76, false],
  ["Sat", "12:00", 43, false],
  ["Sun", "19:00", 52, false],
];

export const DEMO_BEST_TIMES: BestPostingTime[] = BEST_TIME_SEED.map(([day, time, strengthPct, isPeak]) => ({
  day,
  time,
  strengthPct,
  isPeak,
}));

/* -------------------------------------------------------------------------- */
/* Integrations                                                               */
/* -------------------------------------------------------------------------- */

export const DEMO_INTEGRATIONS: IntegrationProvider[] = [
  {
    id: "int_tiktok",
    name: "TikTok",
    category: "SOCIAL",
    status: "CONNECTED",
    accountLabel: "@clippilot",
    lastSyncedAt: iso(addHours(DEMO_NOW, -2)),
    detail: "Publishing and analytics for short-form video.",
    actionsEnabled: false,
  },
  {
    id: "int_instagram",
    name: "Instagram",
    category: "SOCIAL",
    status: "CONNECTED",
    accountLabel: "@clippilot",
    lastSyncedAt: iso(addHours(DEMO_NOW, -3)),
    detail: "Reels publishing, insights and comment sync.",
    actionsEnabled: false,
  },
  {
    id: "int_youtube",
    name: "YouTube",
    category: "SOCIAL",
    status: "NEEDS_REAUTH",
    accountLabel: "ClipPilot AI",
    lastSyncedAt: iso(addDays(DEMO_NOW, -6)),
    detail: "Shorts upload token expired. Reconnect required before the next scheduled upload.",
    actionsEnabled: false,
  },
  {
    id: "int_linkedin",
    name: "LinkedIn",
    category: "SOCIAL",
    status: "CONNECTED",
    accountLabel: "Social Scales",
    lastSyncedAt: iso(addHours(DEMO_NOW, -5)),
    detail: "Company page posting and follower analytics.",
    actionsEnabled: false,
  },
  {
    id: "int_x",
    name: "X (Twitter)",
    category: "SOCIAL",
    status: "NOT_CONNECTED",
    accountLabel: null,
    lastSyncedAt: null,
    detail: "Not connected. Threads and video posts are unavailable until an account is linked.",
    actionsEnabled: false,
  },
  {
    id: "int_aamp",
    name: "AAMP Video Generation",
    category: "GENERATION",
    status: "NOT_CONNECTED",
    accountLabel: null,
    lastSyncedAt: null,
    detail:
      "Reserved seam for the render pipeline. The frontend already models generation jobs; wiring happens in the backend adapter.",
    actionsEnabled: false,
  },
];
