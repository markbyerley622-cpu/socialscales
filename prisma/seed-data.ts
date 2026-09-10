import { ContentFormat, Platform, PublishPolicy } from "../src/generated/prisma/enums";

/**
 * Demo content for the three product ideas under test. Everything here is
 * fictional copy written for the seed; no third-party content is reproduced.
 */

export type HookPatternKey =
  | "question"
  | "pov"
  | "numeric"
  | "contrarian"
  | "problem_solution"
  | "direct";

export type SeedHook = {
  pattern: HookPatternKey;
  hook: string;
  caption: string;
  cta: string;
  label: string;
};

export type SeedAsset = {
  filename: string;
  title: string;
  pillarSlug: string;
  format: ContentFormat;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

export type SeedProject = {
  slug: string;
  name: string;
  description: string;
  accentColor: string;
  timezone: string;
  publishPolicy: PublishPolicy;
  brand: {
    audience: string;
    tone: string;
    valueProp: string;
    website: string;
    primaryCta: string;
    bannedPhrases: string[];
  };
  pillars: Array<{ slug: string; name: string; description: string }>;
  hashtags: string[];
  accounts: Array<{ platform: Platform; handle: string; displayName: string }>;
  /** Recurring posting windows, local to the project's timezone. */
  slots: Array<{ dayOfWeek: number; hour: number; minute: number }>;
  assets: SeedAsset[];
  hooks: SeedHook[];
};

export const SEED_PROJECTS: SeedProject[] = [
  {
    slug: "creator-ai",
    name: "CREATOR AI",
    description:
      "An AI social media operator for creators and small agencies. Positioned against the $2,000/month retainer.",
    accentColor: "#d95926",
    timezone: "America/New_York",
    publishPolicy: PublishPolicy.MANUAL_APPROVAL,
    brand: {
      audience: "creators and solo agency owners",
      tone: "Sharp, internet-native, confident. Short sentences. No corporate filler.",
      valueProp:
        "It plans, writes and schedules a whole month of short-form in an afternoon.",
      website: "https://creatorai.example",
      primaryCta: "Join the beta — link in bio",
      bannedPhrases: ["game-changer", "revolutionary", "unlock your potential"],
    },
    pillars: [
      { slug: "agency-replacement", name: "Agency replacement", description: "Cost and speed against a retainer." },
      { slug: "workflow", name: "Workflow teardown", description: "How the work actually gets done." },
      { slug: "proof", name: "Proof and receipts", description: "Real numbers from real accounts." },
      { slug: "build-log", name: "Build log", description: "Shipping in public." },
    ],
    hashtags: ["#creatoreconomy", "#smma", "#contentstrategy", "#aitools", "#shortform", "#buildinpublic"],
    accounts: [
      { platform: Platform.TIKTOK, handle: "@creatorai", displayName: "Creator AI" },
      { platform: Platform.INSTAGRAM, handle: "@creatorai", displayName: "Creator AI" },
      { platform: Platform.YOUTUBE, handle: "@creatorai", displayName: "Creator AI" },
    ],
    slots: [
      { dayOfWeek: 1, hour: 9, minute: 0 },
      { dayOfWeek: 2, hour: 19, minute: 0 },
      { dayOfWeek: 4, hour: 19, minute: 30 },
      { dayOfWeek: 6, hour: 11, minute: 0 },
    ],
    assets: [
      { filename: "creator-agency-teardown-screen.mp4", title: "Agency teardown", pillarSlug: "agency-replacement", format: ContentFormat.SCREEN_RECORDING, durationSeconds: 24, width: 1080, height: 1920, hasAudio: true },
      { filename: "creator-workflow-tutorial-setup.mp4", title: "Setup in 90 seconds", pillarSlug: "workflow", format: ContentFormat.TUTORIAL, durationSeconds: 38, width: 1080, height: 1920, hasAudio: true },
      { filename: "creator-talking-head-pricing.mp4", title: "Why we charge $29", pillarSlug: "agency-replacement", format: ContentFormat.TALKING_HEAD, durationSeconds: 31, width: 1080, height: 1920, hasAudio: true },
      { filename: "creator-comparison-vs-retainer.mp4", title: "Retainer vs this", pillarSlug: "agency-replacement", format: ContentFormat.COMPARISON, durationSeconds: 19, width: 1080, height: 1920, hasAudio: true },
      { filename: "creator-list-tips-hooks.mp4", title: "Five hooks that worked", pillarSlug: "proof", format: ContentFormat.LIST, durationSeconds: 44, width: 1080, height: 1920, hasAudio: true },
      { filename: "creator-build-day-eleven.mp4", title: "Day 11 of building", pillarSlug: "build-log", format: ContentFormat.BUILD_IN_PUBLIC, durationSeconds: 22, width: 1080, height: 1920, hasAudio: true },
      { filename: "creator-screen-dashboard-walkthrough.mp4", title: "Dashboard walkthrough", pillarSlug: "workflow", format: ContentFormat.SCREEN_RECORDING, durationSeconds: 13, width: 1080, height: 1920, hasAudio: false },
      { filename: "creator-proof-results-carousel.png", title: "30-day results", pillarSlug: "proof", format: ContentFormat.LIST, durationSeconds: 0, width: 1080, height: 1350, hasAudio: false },
    ],
    hooks: [
      { pattern: "problem_solution", label: "Problem / solution", hook: "You are still doing content the hard way.", caption: "Most solo agencies plan a month of content in spreadsheets. It plans, writes and schedules the whole thing in an afternoon.", cta: "Join the beta — link in bio" },
      { pattern: "question", label: "Direct question", hook: "Would you pay $29 instead of $2,000?", caption: "That is the entire pitch. Same output, one afternoon, no retainer.", cta: "Join the beta — link in bio" },
      { pattern: "pov", label: "POV", hook: "POV: you just cancelled your $2,000 retainer.", caption: "Nothing broke. The calendar is still full. That is the part nobody tells you.", cta: "Join the beta — link in bio" },
      { pattern: "numeric", label: "Number-led", hook: "31 posts, 4 hours, 1 person.", caption: "Here is the exact workflow, start to finish, with nothing skipped.", cta: "Comment WORKFLOW and I will send it over" },
      { pattern: "contrarian", label: "Contrarian", hook: "Nobody needs another scheduling tool.", caption: "They need the thinking part done. That is the bit we built.", cta: "Join the beta — link in bio" },
      { pattern: "direct", label: "Direct statement", hook: "This is what a month of content looks like.", caption: "One screen recording, no edits. Judge it for yourself.", cta: "Link in bio" },
    ],
  },
  {
    slug: "university-ai",
    name: "UNIVERSITY AI",
    description:
      "A study and deadline assistant for university students. Funny, useful, and priced like a coffee.",
    accentColor: "#199e70",
    timezone: "Europe/London",
    publishPolicy: PublishPolicy.MANUAL_APPROVAL,
    brand: {
      audience: "university students",
      tone: "Funny, relatable, useful. Speaks like a classmate, not a careers office.",
      valueProp:
        "It turns a reading list and a deadline into a plan you will actually follow.",
      website: "https://universityai.example",
      primaryCta: "Join the waitlist — link in bio",
      bannedPhrases: ["synergy", "leverage your learning"],
    },
    pillars: [
      { slug: "deadlines", name: "Deadline rescue", description: "The night before, handled." },
      { slug: "study-systems", name: "Study systems", description: "Methods that survive week 8." },
      { slug: "campus-life", name: "Campus life", description: "Relatable, shareable, light." },
      { slug: "results", name: "Grades and results", description: "Before and after." },
    ],
    hashtags: ["#studytok", "#unilife", "#studytips", "#revision", "#studentlife", "#exams"],
    accounts: [
      { platform: Platform.TIKTOK, handle: "@universityai", displayName: "University AI" },
      { platform: Platform.INSTAGRAM, handle: "@universityai", displayName: "University AI" },
    ],
    slots: [
      { dayOfWeek: 0, hour: 20, minute: 0 },
      { dayOfWeek: 2, hour: 13, minute: 0 },
      { dayOfWeek: 3, hour: 20, minute: 30 },
      { dayOfWeek: 5, hour: 17, minute: 0 },
    ],
    assets: [
      { filename: "uni-deadline-night-before-story.mp4", title: "The night before", pillarSlug: "deadlines", format: ContentFormat.STORY, durationSeconds: 27, width: 1080, height: 1920, hasAudio: true },
      { filename: "uni-study-system-tutorial.mp4", title: "The week-8 system", pillarSlug: "study-systems", format: ContentFormat.TUTORIAL, durationSeconds: 41, width: 1080, height: 1920, hasAudio: true },
      { filename: "uni-screen-reading-list-demo.mp4", title: "Reading list to plan", pillarSlug: "study-systems", format: ContentFormat.SCREEN_RECORDING, durationSeconds: 16, width: 1080, height: 1920, hasAudio: false },
      { filename: "uni-talking-head-grades.mp4", title: "What changed my grades", pillarSlug: "results", format: ContentFormat.TALKING_HEAD, durationSeconds: 34, width: 1080, height: 1920, hasAudio: true },
      { filename: "uni-list-five-mistakes.mp4", title: "Five revision mistakes", pillarSlug: "study-systems", format: ContentFormat.LIST, durationSeconds: 49, width: 1080, height: 1920, hasAudio: true },
      { filename: "uni-campus-reaction-timetable.mp4", title: "9am seminar reaction", pillarSlug: "campus-life", format: ContentFormat.REACTION, durationSeconds: 12, width: 1080, height: 1920, hasAudio: true },
      { filename: "uni-comparison-before-after.mp4", title: "Week 1 vs week 9", pillarSlug: "results", format: ContentFormat.COMPARISON, durationSeconds: 21, width: 1080, height: 1920, hasAudio: true },
    ],
    hooks: [
      { pattern: "pov", label: "POV", hook: "POV: the deadline is in 9 hours and you have 40 pages left.", caption: "It reads the list, splits the work and tells you what to skip. Not glamorous. Very effective.", cta: "Join the waitlist — link in bio" },
      { pattern: "question", label: "Direct question", hook: "Why does everyone start revising in week 9?", caption: "Because nobody plans backwards from the exam. So we made the thing that does.", cta: "Join the waitlist — link in bio" },
      { pattern: "numeric", label: "Number-led", hook: "3 hours of reading, 12 minutes of planning.", caption: "That ratio is the whole trick. Here is what the plan looks like.", cta: "Comment PLAN and I will send it" },
      { pattern: "problem_solution", label: "Problem / solution", hook: "Stop doing revision timetables by hand.", caption: "They are out of date by Tuesday. This one moves when you do.", cta: "Join the waitlist — link in bio" },
      { pattern: "contrarian", label: "Contrarian", hook: "Flashcards are not a study system.", caption: "They are a memory tool inside a system. This is the system.", cta: "Join the waitlist — link in bio" },
      { pattern: "direct", label: "Direct statement", hook: "This is my actual reading week plan.", caption: "Unedited, including the bits I did not finish.", cta: "Link in bio" },
    ],
  },
  {
    slug: "travel-ai",
    name: "TRAVEL AI",
    description:
      "An itinerary planner for young travellers. Visual, aspirational, and genuinely practical about money.",
    accentColor: "#9085e9",
    timezone: "Europe/Lisbon",
    publishPolicy: PublishPolicy.SMART_APPROVAL,
    brand: {
      audience: "young travellers on a budget",
      tone: "Visual, aspirational, practical. Beautiful shots, honest numbers.",
      valueProp:
        "It turns a rough idea and a budget into a day-by-day itinerary with real prices.",
      website: "https://travelai.example",
      primaryCta: "Plan your trip — link in bio",
      bannedPhrases: ["hidden gem", "bucket list"],
    },
    pillars: [
      { slug: "itineraries", name: "Itineraries", description: "Day-by-day, costed." },
      { slug: "budget", name: "Real budgets", description: "What it actually costs." },
      { slug: "destinations", name: "Destinations", description: "Place-led visual content." },
      { slug: "mistakes", name: "Travel mistakes", description: "What went wrong and why." },
    ],
    hashtags: ["#budgettravel", "#traveltok", "#itinerary", "#solotravel", "#traveltips", "#europe"],
    accounts: [
      { platform: Platform.TIKTOK, handle: "@travelai", displayName: "Travel AI" },
      { platform: Platform.INSTAGRAM, handle: "@travelai", displayName: "Travel AI" },
      { platform: Platform.YOUTUBE, handle: "@travelai", displayName: "Travel AI" },
    ],
    slots: [
      { dayOfWeek: 1, hour: 13, minute: 0 },
      { dayOfWeek: 3, hour: 18, minute: 0 },
      { dayOfWeek: 5, hour: 12, minute: 0 },
      { dayOfWeek: 6, hour: 19, minute: 0 },
    ],
    assets: [
      { filename: "travel-lisbon-3day-screen.mp4", title: "Lisbon in 3 days", pillarSlug: "itineraries", format: ContentFormat.SCREEN_RECORDING, durationSeconds: 29, width: 1080, height: 1920, hasAudio: true },
      { filename: "travel-budget-breakdown-tutorial.mp4", title: "What a week really costs", pillarSlug: "budget", format: ContentFormat.TUTORIAL, durationSeconds: 46, width: 1080, height: 1920, hasAudio: true },
      { filename: "travel-destination-story-porto.mp4", title: "Porto, honestly", pillarSlug: "destinations", format: ContentFormat.STORY, durationSeconds: 33, width: 1080, height: 1920, hasAudio: true },
      { filename: "travel-mistakes-talking-head.mp4", title: "Three booking mistakes", pillarSlug: "mistakes", format: ContentFormat.TALKING_HEAD, durationSeconds: 25, width: 1080, height: 1920, hasAudio: true },
      { filename: "travel-comparison-train-vs-flight.mp4", title: "Train vs flight", pillarSlug: "budget", format: ContentFormat.COMPARISON, durationSeconds: 18, width: 1080, height: 1920, hasAudio: true },
      { filename: "travel-list-packing.mp4", title: "Packing list that fits", pillarSlug: "mistakes", format: ContentFormat.LIST, durationSeconds: 52, width: 1080, height: 1920, hasAudio: true },
      { filename: "travel-destination-photo-set.png", title: "Lisbon photo set", pillarSlug: "destinations", format: ContentFormat.LIST, durationSeconds: 0, width: 1080, height: 1350, hasAudio: false },
    ],
    hooks: [
      { pattern: "numeric", label: "Number-led", hook: "3 days in Lisbon for 210 euros.", caption: "Every line item, including the two things that were not worth it.", cta: "Plan your trip — link in bio" },
      { pattern: "question", label: "Direct question", hook: "How much does a week in Portugal actually cost?", caption: "Not the influencer number. The real one, with receipts.", cta: "Plan your trip — link in bio" },
      { pattern: "problem_solution", label: "Problem / solution", hook: "Stop planning trips in 40 browser tabs.", caption: "Give it a budget and a rough idea. It comes back with a day-by-day plan and real prices.", cta: "Plan your trip — link in bio" },
      { pattern: "pov", label: "POV", hook: "POV: your itinerary already knows the trains are on strike.", caption: "It re-plans the day instead of ruining it.", cta: "Plan your trip — link in bio" },
      { pattern: "contrarian", label: "Contrarian", hook: "Never book the first flight you find.", caption: "Here is the 20-minute check that saved 140 euros.", cta: "Comment TRIP for the checklist" },
      { pattern: "direct", label: "Direct statement", hook: "This is the itinerary it made me.", caption: "Unedited output, including the walking times.", cta: "Link in bio" },
    ],
  },
];

export type SeedExperiment = {
  projectSlug: string;
  name: string;
  hypothesis: string;
  metric: string;
  controlPattern: HookPatternKey;
  variantPattern: HookPatternKey;
};

export const SEED_EXPERIMENTS: SeedExperiment[] = [
  {
    projectSlug: "creator-ai",
    name: "Hook test — price anchor vs POV",
    hypothesis:
      "Naming the $2,000 retainer explicitly in the hook drives more profile visits than a POV framing, because it states the stakes before the viewer decides to scroll.",
    metric: "profileVisits",
    controlPattern: "pov",
    variantPattern: "question",
  },
  {
    projectSlug: "university-ai",
    name: "Hook test — deadline panic vs system",
    hypothesis:
      "Deadline-panic openers win on views but system openers win on completion, because the audience for each is different.",
    metric: "completionRate",
    controlPattern: "pov",
    variantPattern: "problem_solution",
  },
  {
    projectSlug: "travel-ai",
    name: "Hook test — exact price vs question",
    hypothesis:
      "A concrete number in the first three words outperforms an open question for a budget-led audience.",
    metric: "views",
    controlPattern: "question",
    variantPattern: "numeric",
  },
];
