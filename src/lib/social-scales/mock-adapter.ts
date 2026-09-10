/**
 * MockSocialScalesAdapter — development implementation of SocialScalesAdapter.
 *
 * Backed entirely by `src/mocks/fixtures.ts`. State mutations (approve,
 * schedule, script edits, generation) are held in module memory so the app
 * feels alive during local development; they are lost on server restart, which
 * is the correct trade-off for a fixture layer.
 *
 * This file must never be imported by a React component.
 */

import { addDays, addHours, format, formatISO, isSameDay, parseISO, startOfWeek } from "date-fns";

import {
  DEMO_ACTIVITY,
  DEMO_ASSETS,
  DEMO_BEST_TIMES,
  DEMO_BRAND_PROFILE,
  DEMO_BRIEF,
  DEMO_BRIEFS,
  DEMO_CAPTION_STYLES,
  DEMO_CLIENTS,
  DEMO_CONTENT_ITEMS,
  DEMO_DASHBOARD_METRICS,
  DEMO_HEADLINE_METRICS,
  DEMO_IDEAS,
  DEMO_INSIGHTS,
  DEMO_INTEGRATIONS,
  DEMO_NOW,
  DEMO_PILLARS,
  DEMO_PILLAR_PERFORMANCE,
  DEMO_PLAN_HISTORY,
  DEMO_SCRIPT,
  DEMO_SECONDARY_METRICS,
  DEMO_TOP_CONTENT,
  DEMO_VARIANTS,
  DEMO_WEEK_START,
  DEMO_WORKSPACE,
  PRIMARY_CLIENT_ID,
  demoSeries,
} from "@/mocks/fixtures";

import type {
  AnalyticsFilters,
  AnalyticsPeriod,
  CalendarRange,
  ContentQueueFilters,
  RewriteDirective,
  ScriptPatch,
  SocialScalesAdapter,
} from "./adapter";
import { AdapterError } from "./adapter";
import type {
  AnalyticsSummary,
  ApprovalItem,
  BrandProfile,
  CalendarSlotPost,
  CalendarView,
  Client,
  ContentIdea,
  ContentItem,
  ContentPlan,
  ContentQueueView,
  DashboardView,
  GenerationJob,
  IntegrationProvider,
  LearningInsight,
  OnboardingState,
  PipelineStage,
  PlanHistoryEntry,
  QueueCounts,
  ScheduledPost,
  ScriptDraft,
  StudioView,
  Workspace,
} from "./contracts";

/* -------------------------------------------------------------------------- */
/* Mutable development state                                                  */
/* -------------------------------------------------------------------------- */

interface MockState {
  items: ContentItem[];
  ideas: ContentIdea[];
  script: ScriptDraft;
  onboarding: OnboardingState;
  planStatus: ContentPlan["status"];
  planGeneration: number;
}

const globalKey = Symbol.for("social-scales.mock-state");
type GlobalWithState = typeof globalThis & { [globalKey]?: MockState };

function createState(): MockState {
  return {
    items: DEMO_CONTENT_ITEMS.map((item) => ({ ...item })),
    ideas: DEMO_IDEAS.map((idea) => ({ ...idea })),
    script: { ...DEMO_SCRIPT },
    onboarding: {
      clientId: PRIMARY_CLIENT_ID,
      complete: true,
      currentStep: "BUSINESS",
      completedSteps: ["BUSINESS", "GOALS", "AUDIENCE", "BRAND_VOICE", "PLATFORMS", "FIRST_STRATEGY"],
      draft: { ...DEMO_BRAND_PROFILE },
    },
    planStatus: "ACTIVE",
    planGeneration: 0,
  };
}

/** Survives Next.js dev-server module reloads. */
function state(): MockState {
  const g = globalThis as GlobalWithState;
  if (!g[globalKey]) g[globalKey] = createState();
  return g[globalKey];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const iso = (d: Date) => formatISO(d);

function countQueue(items: ContentItem[]): QueueCounts {
  const tally = (s: ContentItem["status"]) => items.filter((i) => i.status === s).length;
  return {
    ideas: tally("IDEA"),
    briefs: tally("BRIEF"),
    scripts: tally("SCRIPT"),
    assetsReady: tally("ASSET_READY"),
    generating: tally("GENERATING"),
    needsReview: tally("NEEDS_REVIEW"),
    approved: tally("APPROVED"),
    scheduled: tally("SCHEDULED"),
    published: tally("PUBLISHED"),
    failed: tally("FAILED"),
  };
}

function toScheduledPost(item: ContentItem): ScheduledPost {
  return {
    id: `sp_${item.id}`,
    contentItemId: item.id,
    title: item.title,
    clientName: item.clientName,
    platform: item.platform,
    scheduledFor: item.plannedPublishAt ?? iso(DEMO_NOW),
    status: item.status,
    thumbnailTone: item.thumbnailTone,
  };
}

function activePlan(): ContentPlan {
  const s = state();
  const shipped = DEMO_BRIEFS.filter((b) => b.status === "PUBLISHED").length;
  return {
    id: `plan_w37_${s.planGeneration}`,
    clientId: PRIMARY_CLIENT_ID,
    label: `Week of ${format(DEMO_WEEK_START, "d MMM yyyy")}`,
    status: s.planStatus,
    periodStart: iso(DEMO_WEEK_START),
    periodEnd: iso(addDays(DEMO_WEEK_START, 6)),
    objective: "Grow qualified awareness and drive booked strategy calls.",
    audienceSummary:
      "Creators, coaches and small business owners who already post but cannot keep a consistent system running.",
    cadence: "3-5 posts per week across TikTok, Instagram, YouTube and LinkedIn.",
    pillars: DEMO_PILLARS,
    briefs: DEMO_BRIEFS,
    adherencePct: Math.round((shipped / DEMO_BRIEFS.length) * 100),
    createdAt: iso(addDays(DEMO_WEEK_START, -1)),
  };
}

const PIPELINE_COPY: Array<{ key: PipelineStage["key"]; label: string; description: string }> = [
  { key: "PLAN", label: "Plan", description: "Objective, pillars and this week's briefs." },
  { key: "IDEAS", label: "Ideas", description: "Angles generated against the plan." },
  { key: "SCRIPTS", label: "Scripts", description: "Hook, body and CTA written to brand voice." },
  { key: "CONTENT", label: "Content", description: "Assets assembled, captions applied, rendered." },
  { key: "PUBLISH", label: "Publish", description: "Approved, scheduled and pushed to platforms." },
  { key: "LEARN", label: "Learn", description: "Performance read back into the next plan." },
];

/** Small artificial latency so loading states are exercised in development. */
const tick = <T,>(value: T, ms = 0): Promise<T> =>
  ms > 0 ? new Promise((resolve) => setTimeout(() => resolve(value), ms)) : Promise.resolve(value);

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

export class MockSocialScalesAdapter implements SocialScalesAdapter {
  readonly mode = "mock" as const;

  async getWorkspace(): Promise<Workspace> {
    return tick(DEMO_WORKSPACE);
  }

  async getOnboardingState(): Promise<OnboardingState> {
    return tick({ ...state().onboarding });
  }

  async saveOnboardingDraft(draft: Partial<BrandProfile>): Promise<OnboardingState> {
    const s = state();
    s.onboarding = { ...s.onboarding, draft: { ...s.onboarding.draft, ...draft } };
    return tick({ ...s.onboarding });
  }

  async completeOnboarding(profile: Partial<BrandProfile>): Promise<{ planId: string }> {
    const s = state();
    s.onboarding = {
      ...s.onboarding,
      complete: true,
      completedSteps: ["BUSINESS", "GOALS", "AUDIENCE", "BRAND_VOICE", "PLATFORMS", "FIRST_STRATEGY"],
      draft: { ...s.onboarding.draft, ...profile },
    };
    s.planStatus = "AWAITING_APPROVAL";
    s.planGeneration += 1;
    return tick({ planId: activePlan().id }, 400);
  }

  async getDashboard(): Promise<DashboardView> {
    const s = state();
    const items = s.items;
    const queue = countQueue(items);
    const plan = activePlan();

    const pipeline: PipelineStage[] = PIPELINE_COPY.map((stage) => {
      const count =
        stage.key === "PLAN"
          ? plan.briefs.length
          : stage.key === "IDEAS"
            ? s.ideas.length
            : stage.key === "SCRIPTS"
              ? queue.scripts + queue.briefs
              : stage.key === "CONTENT"
                ? queue.generating + queue.needsReview + queue.assetsReady
                : stage.key === "PUBLISH"
                  ? queue.approved + queue.scheduled
                  : DEMO_INSIGHTS.length;
      return { ...stage, count };
    });

    const approvals: ApprovalItem[] = items
      .filter((i) => i.status === "NEEDS_REVIEW")
      .map((i, index) => ({
        id: `ap_${i.id}`,
        contentItemId: i.id,
        title: i.title,
        clientName: i.clientName,
        platform: i.platform,
        reason:
          i.generation?.qaStatus === "FLAGGED"
            ? "Automated QA flagged the caption timing."
            : "Waiting on your approval before it can be scheduled.",
        waitingSinceHours: 2 + index * 3,
      }));

    const upcomingPosts = items
      .filter((i) => (i.status === "SCHEDULED" || i.status === "APPROVED") && i.plannedPublishAt)
      .sort((a, b) => (a.plannedPublishAt! < b.plannedPublishAt! ? -1 : 1))
      .slice(0, 6)
      .map(toScheduledPost);

    const weekAtAGlance = Array.from({ length: 7 }, (_, offset) => {
      const day = addDays(DEMO_WEEK_START, offset);
      return {
        dayLabel: format(day, "EEE").toUpperCase(),
        date: format(day, "d MMM"),
        posts: items
          .filter((i) => i.plannedPublishAt && isSameDay(parseISO(i.plannedPublishAt), day))
          .map(toScheduledPost),
      };
    });

    return tick({
      workspace: DEMO_WORKSPACE,
      plan: {
        id: plan.id,
        label: plan.label,
        status: plan.status,
        objective: plan.objective,
        adherencePct: plan.adherencePct,
        periodLabel: `${format(parseISO(plan.periodStart), "d MMM")} - ${format(parseISO(plan.periodEnd), "d MMM yyyy")}`,
      },
      pipeline,
      queue,
      approvals,
      upcomingPosts,
      recentActivity: DEMO_ACTIVITY,
      insights: DEMO_INSIGHTS.slice(0, 4),
      metrics: DEMO_DASHBOARD_METRICS,
      performanceSeries: demoSeries(30)[0],
      clients: DEMO_CLIENTS,
      weekAtAGlance,
    });
  }

  async getClients(): Promise<Client[]> {
    return tick(DEMO_CLIENTS);
  }

  async getClient(id: string): Promise<Client | null> {
    return tick(DEMO_CLIENTS.find((c) => c.id === id) ?? null);
  }

  async getActivePlan(): Promise<ContentPlan | null> {
    return tick(activePlan());
  }

  async getPlanHistory(): Promise<PlanHistoryEntry[]> {
    return tick(DEMO_PLAN_HISTORY);
  }

  async createPlan(): Promise<ContentPlan> {
    const s = state();
    s.planGeneration += 1;
    s.planStatus = "AWAITING_APPROVAL";
    return tick(activePlan(), 500);
  }

  async approvePlan(): Promise<ContentPlan> {
    state().planStatus = "ACTIVE";
    return tick(activePlan(), 200);
  }

  async getContentQueue(filters: ContentQueueFilters = {}): Promise<ContentQueueView> {
    const items = state().items.filter((item) => {
      if (filters.status && item.status !== filters.status) return false;
      if (filters.clientId && item.clientId !== filters.clientId) return false;
      if (filters.platform && item.platform !== filters.platform) return false;
      if (filters.search) {
        const needle = filters.search.toLowerCase();
        if (!`${item.title} ${item.hook}`.toLowerCase().includes(needle)) return false;
      }
      return true;
    });

    return tick({
      counts: countQueue(state().items),
      items: [...items].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)),
    });
  }

  async getContentItem(id: string): Promise<ContentItem | null> {
    return tick(state().items.find((i) => i.id === id) ?? null);
  }

  async getStudio(contentItemId?: string): Promise<StudioView> {
    const s = state();
    const item = contentItemId ? s.items.find((i) => i.id === contentItemId) : s.items[0];
    if (!item) throw new AdapterError("NOT_FOUND", `Content item ${contentItemId} was not found.`);

    return tick({
      contentItem: item,
      ideas: s.ideas,
      brief: DEMO_BRIEF,
      script: item.id === s.script.contentItemId ? s.script : { ...s.script, contentItemId: item.id, workingTitle: item.title, hook: item.hook },
      variants: DEMO_VARIANTS,
      assets: DEMO_ASSETS.map((a) => ({ ...a, selected: item.assetIds.includes(a.id) })),
      captionStyles: DEMO_CAPTION_STYLES,
      activeCaptionStyleId: DEMO_CAPTION_STYLES[0].id,
    });
  }

  async getIdeas(): Promise<ContentIdea[]> {
    return tick(state().ideas);
  }

  async createContentIdea(clientId: string, title: string): Promise<ContentIdea> {
    const s = state();
    const idea: ContentIdea = {
      id: `idea_${s.ideas.length + 1}_${s.planGeneration}`,
      clientId,
      title,
      rationale: "Added manually. Not yet scored against the plan.",
      pillarId: DEMO_PILLARS[0].id,
      platform: "TIKTOK",
      source: "SAVED",
      potential: "EXPLORATORY",
      thumbnailTone: "slate",
      createdAt: iso(DEMO_NOW),
    };
    s.ideas = [idea, ...s.ideas];
    return tick(idea);
  }

  async generateIdeas(clientId: string, count: number): Promise<ContentIdea[]> {
    const s = state();
    const angles = [
      "The hidden cost of posting inconsistently",
      "What we would do with 30 days and no budget",
      "One workflow change that doubled our output",
      "Why your best post did not reach your followers",
      "The content audit we run before every plan",
    ];
    const fresh: ContentIdea[] = Array.from({ length: count }, (_, i) => ({
      id: `idea_gen_${s.ideas.length + i}`,
      clientId,
      title: angles[i % angles.length],
      rationale: "Generated against the active plan objective and the strongest recent hooks.",
      pillarId: DEMO_PILLARS[i % DEMO_PILLARS.length].id,
      platform: "TIKTOK",
      source: "FOR_YOU",
      potential: i === 0 ? "HIGH" : "MEDIUM",
      thumbnailTone: ["cyan", "violet", "teal", "indigo", "amber"][i % 5],
      createdAt: iso(DEMO_NOW),
    }));
    s.ideas = [...fresh, ...s.ideas];
    return tick(fresh, 600);
  }

  async updateScript(contentItemId: string, patch: ScriptPatch): Promise<ScriptDraft> {
    const s = state();
    s.script = {
      ...s.script,
      ...patch,
      contentItemId,
      generatedBy: "AI_EDITED",
      updatedAt: iso(DEMO_NOW),
    };
    return tick({ ...s.script });
  }

  async rewriteScript(contentItemId: string, directive: RewriteDirective): Promise<ScriptDraft> {
    const s = state();
    const base = s.script;

    const rewritten: Record<RewriteDirective, Partial<ScriptDraft>> = {
      BRAND_VOICE: {
        hook: "You are losing hours every week to content that a system should be handling.",
        cta: "Same platform. Bigger possibilities. Book a free strategy call at Social Scales.",
      },
      SHORTER: {
        body: "Ideas in. Briefs, scripts and edits out. Scheduled to the platforms you already use.",
      },
      STRONGER_HOOK: {
        hook: "Ten hours a week. That is what manual content is quietly costing you.",
      },
      MORE_DIRECT: {
        hook: "Stop making content by hand.",
        cta: "Book a strategy call. We will build the system with you.",
      },
    };

    s.script = {
      ...base,
      ...rewritten[directive],
      contentItemId,
      generatedBy: "AI_EDITED",
      updatedAt: iso(DEMO_NOW),
    };
    return tick({ ...s.script }, 450);
  }

  async generateContent(contentItemId: string): Promise<GenerationJob> {
    const s = state();
    const item = s.items.find((i) => i.id === contentItemId);
    if (!item) throw new AdapterError("NOT_FOUND", `Content item ${contentItemId} was not found.`);

    const generation: GenerationJob = {
      generationJobId: `gj_${contentItemId}_${Date.now()}`,
      contentItemId,
      status: "QUEUED",
      progress: 0,
      previewUrl: null,
      finalVideoUrl: null,
      thumbnailUrl: null,
      qaStatus: "PENDING",
      failureReason: null,
      createdAt: iso(DEMO_NOW),
      completedAt: null,
    };

    item.status = "GENERATING";
    item.generation = generation;
    return tick(generation, 300);
  }

  async getGenerationJob(generationJobId: string): Promise<GenerationJob | null> {
    const job = state()
      .items.map((i) => i.generation)
      .find((g) => g?.generationJobId === generationJobId);
    return tick(job ?? null);
  }

  async approveContent(contentItemId: string): Promise<ContentItem> {
    const item = state().items.find((i) => i.id === contentItemId);
    if (!item) throw new AdapterError("NOT_FOUND", `Content item ${contentItemId} was not found.`);
    item.status = "APPROVED";
    item.approvalRequired = false;
    item.updatedAt = iso(DEMO_NOW);
    return tick({ ...item }, 250);
  }

  async scheduleContent(contentItemId: string, isoDateTime: string): Promise<ContentItem> {
    const item = state().items.find((i) => i.id === contentItemId);
    if (!item) throw new AdapterError("NOT_FOUND", `Content item ${contentItemId} was not found.`);
    item.status = "SCHEDULED";
    item.plannedPublishAt = isoDateTime;
    item.approvalRequired = false;
    item.updatedAt = iso(DEMO_NOW);
    return tick({ ...item }, 250);
  }

  async getCalendar(range: CalendarRange): Promise<CalendarView> {
    const s = state();
    const anchor = range.start ? parseISO(range.start) : DEMO_NOW;
    const start = startOfWeek(anchor, { weekStartsOn: 1 });
    const dayCount = range.mode === "WEEK" ? 7 : 35;

    const hourRows = ["8 AM", "10 AM", "12 PM", "2 PM", "4 PM", "6 PM"];
    const hourFor = (date: Date) => {
      const h = date.getHours();
      if (h < 9) return "8 AM";
      if (h < 11) return "10 AM";
      if (h < 14) return "12 PM";
      if (h < 16) return "2 PM";
      if (h < 18) return "4 PM";
      return "6 PM";
    };

    const matches = (item: ContentItem) => {
      if (range.clientId && item.clientId !== range.clientId) return false;
      if (range.platform && item.platform !== range.platform) return false;
      return true;
    };

    const days = Array.from({ length: dayCount }, (_, offset) => {
      const day = addDays(start, offset);
      const posts: CalendarSlotPost[] = s.items
        .filter((i) => matches(i) && i.plannedPublishAt && isSameDay(parseISO(i.plannedPublishAt), day))
        .map((i) => ({ ...toScheduledPost(i), hourLabel: hourFor(parseISO(i.plannedPublishAt!)) }));
      return {
        dayLabel: format(day, "EEE").toUpperCase(),
        date: format(day, "d MMM"),
        isToday: isSameDay(day, DEMO_NOW),
        posts,
      };
    });

    const end = addDays(start, dayCount - 1);

    const scheduledQueue = s.items
      .filter((i) => matches(i) && (i.status === "SCHEDULED" || i.status === "APPROVED") && i.plannedPublishAt)
      .sort((a, b) => (a.plannedPublishAt! < b.plannedPublishAt! ? -1 : 1))
      .map(toScheduledPost);

    return tick({
      rangeLabel: `${format(start, "d MMM")} - ${format(end, "d MMM yyyy")}`,
      rangeStart: iso(start),
      rangeEnd: iso(end),
      hourRows,
      days,
      scheduledQueue,
      bestPostingTimes: DEMO_BEST_TIMES,
    });
  }

  async getAnalytics(period: AnalyticsPeriod, filters: AnalyticsFilters = {}): Promise<AnalyticsSummary> {
    const days = period === "LAST_7_DAYS" ? 7 : period === "LAST_30_DAYS" ? 30 : 90;
    const scale = period === "LAST_7_DAYS" ? 0.28 : period === "LAST_30_DAYS" ? 1 : 2.7;

    const topContent = filters.platform
      ? DEMO_TOP_CONTENT.filter((row) => row.platform === filters.platform)
      : DEMO_TOP_CONTENT;

    return tick({
      periodLabel:
        period === "LAST_7_DAYS" ? "Last 7 days" : period === "LAST_30_DAYS" ? "Last 30 days" : "Last 90 days",
      isDemoData: true,
      headline: DEMO_HEADLINE_METRICS.map((m) => ({ ...m, value: Math.round(m.value * scale) })),
      secondary: DEMO_SECONDARY_METRICS.map((m) =>
        m.format === "COUNT" ? { ...m, value: Math.round(m.value * scale) } : m,
      ),
      series: demoSeries(days),
      topContent,
      pillarPerformance: DEMO_PILLAR_PERFORMANCE,
      bestPostingTimes: DEMO_BEST_TIMES,
    });
  }

  async getInsights(): Promise<LearningInsight[]> {
    return tick(DEMO_INSIGHTS);
  }

  async getIntegrations(): Promise<IntegrationProvider[]> {
    return tick(DEMO_INTEGRATIONS);
  }
}

/** Exported for tests and for the studio preview clock. */
export const MOCK_NOW = DEMO_NOW;
export const MOCK_WEEK_START = DEMO_WEEK_START;
export const mockHoursFromNow = (h: number) => iso(addHours(DEMO_NOW, h));
