/**
 * Social Scales — frontend-facing domain contracts.
 *
 * These types are the ONLY vocabulary the UI is allowed to speak. They are
 * deliberately decoupled from any backend implementation detail (Prisma models,
 * job-queue payloads, AI provider SDK shapes, publishing provider responses).
 *
 * When the real SMMA backend is connected, it must map its internal models into
 * these shapes inside an adapter — not the other way around.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Lifecycle enums                                                            */
/* -------------------------------------------------------------------------- */

export const CONTENT_STATUSES = [
  "IDEA",
  "BRIEF",
  "SCRIPT",
  "ASSET_READY",
  "GENERATING",
  "NEEDS_REVIEW",
  "APPROVED",
  "SCHEDULED",
  "PUBLISHED",
  "FAILED",
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const GENERATION_STATUSES = [
  "QUEUED",
  "PLANNING",
  "GENERATING",
  "RENDERING",
  "QA",
  "READY",
  "FAILED",
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const PLATFORMS = ["TIKTOK", "INSTAGRAM", "YOUTUBE", "LINKEDIN", "X"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const INTEGRATION_STATUSES = [
  "NOT_CONNECTED",
  "CONNECTING",
  "CONNECTED",
  "NEEDS_REAUTH",
  "ERROR",
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const ONBOARDING_STEPS = [
  "BUSINESS",
  "GOALS",
  "AUDIENCE",
  "BRAND_VOICE",
  "PLATFORMS",
  "FIRST_STRATEGY",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const CLIENT_STATUSES = ["ONBOARDING", "ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const PLAN_STATUSES = ["DRAFT", "AWAITING_APPROVAL", "ACTIVE", "COMPLETED"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const QA_STATUSES = ["PENDING", "PASSED", "FLAGGED", "FAILED"] as const;
export type QaStatus = (typeof QA_STATUSES)[number];

export const ASSET_KINDS = ["VIDEO", "IMAGE", "AUDIO", "GRAPHIC", "BRAND_KIT"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* Core entities                                                              */
/* -------------------------------------------------------------------------- */

export interface Workspace {
  id: string;
  name: string;
  tagline: string;
  plan: string;
  ownerName: string;
  ownerRole: string;
  /** True when the backing data came from the development mock adapter. */
  isDemoData: boolean;
}

export interface BrandProfile {
  businessName: string;
  website: string | null;
  niche: string;
  offer: string;
  productsServices: string[];
  idealCustomer: string;
  businessObjective: string;
  contentGoals: string[];
  primaryCta: string;
  toneOfVoice: string[];
  phrasesToUse: string[];
  claimsToAvoid: string[];
  competitors: string[];
  platforms: Platform[];
  postingFrequency: string;
  existingSocialLinks: string[];
  assetAvailability: "NONE" | "SOME" | "RICH_LIBRARY";
  approvalPreference: "REVIEW_EVERYTHING" | "REVIEW_FIRST_WEEK" | "AUTO_PUBLISH";
}

export interface Client {
  id: string;
  name: string;
  initials: string;
  niche: string;
  status: ClientStatus;
  onboardingComplete: boolean;
  connectedPlatforms: Platform[];
  planStatus: PlanStatus;
  postsThisWeek: number;
  awaitingApproval: number;
  upcomingPosts: number;
  /** Percentage change vs previous period. Null when not measurable yet. */
  engagementTrendPct: number | null;
  health: "HEALTHY" | "ATTENTION" | "AT_RISK";
  lastActivityAt: string;
}

export interface OnboardingState {
  clientId: string | null;
  complete: boolean;
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  draft: Partial<BrandProfile>;
}

export interface ContentPillar {
  id: string;
  name: string;
  description: string;
  sharePct: number;
  colorToken: "accent" | "violet" | "ok" | "warn" | "info";
}

export interface PlannedBrief {
  id: string;
  dayLabel: string;
  scheduledFor: string;
  platform: Platform;
  pillarId: string;
  title: string;
  angle: string;
  status: ContentStatus;
}

export interface ContentPlan {
  id: string;
  clientId: string;
  label: string;
  status: PlanStatus;
  periodStart: string;
  periodEnd: string;
  objective: string;
  audienceSummary: string;
  cadence: string;
  pillars: ContentPillar[];
  briefs: PlannedBrief[];
  /** 0-100. Share of planned briefs that actually shipped. */
  adherencePct: number;
  createdAt: string;
}

export interface PlanHistoryEntry {
  id: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  adherencePct: number;
  postsPublished: number;
  headline: string;
}

export interface ContentIdea {
  id: string;
  clientId: string;
  title: string;
  rationale: string;
  pillarId: string;
  platform: Platform;
  source: "FOR_YOU" | "TRENDING" | "CLIENT_GOALS" | "SAVED";
  potential: "HIGH" | "MEDIUM" | "EXPLORATORY";
  thumbnailTone: string;
  createdAt: string;
}

export interface ContentBrief {
  id: string;
  ideaId: string;
  problem: string;
  transformation: string;
  proofPoint: string;
  callToAction: string;
  targetDurationSec: number;
}

export interface ScriptDraft {
  id: string;
  contentItemId: string;
  workingTitle: string;
  hook: string;
  body: string;
  cta: string;
  hookWindowSec: [number, number];
  bodyWindowSec: [number, number];
  ctaWindowSec: [number, number];
  generatedBy: "AI" | "HUMAN" | "AI_EDITED";
  updatedAt: string;
}

export interface MediaAsset {
  id: string;
  clientId: string;
  fileName: string;
  kind: AssetKind;
  durationSec: number | null;
  /** Decorative gradient token — real deployments swap in real thumbnails. */
  thumbnailTone: string;
  selected: boolean;
  addedAt: string;
}

export interface GenerationJob {
  generationJobId: string;
  contentItemId: string;
  status: GenerationStatus;
  /** 0-100 */
  progress: number;
  previewUrl: string | null;
  finalVideoUrl: string | null;
  thumbnailUrl: string | null;
  qaStatus: QaStatus;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ContentItem {
  id: string;
  clientId: string;
  clientName: string;
  title: string;
  hook: string;
  platform: Platform;
  pillarId: string;
  status: ContentStatus;
  generation: GenerationJob | null;
  plannedPublishAt: string | null;
  durationSec: number | null;
  assetIds: string[];
  approvalRequired: boolean;
  thumbnailTone: string;
  updatedAt: string;
}

export interface ScriptVariant {
  id: string;
  label: string;
  angle: string;
  selected: boolean;
}

export interface ApprovalItem {
  id: string;
  contentItemId: string;
  title: string;
  clientName: string;
  platform: Platform;
  reason: string;
  waitingSinceHours: number;
}

export interface ScheduledPost {
  id: string;
  contentItemId: string;
  title: string;
  clientName: string;
  platform: Platform;
  scheduledFor: string;
  status: ContentStatus;
  thumbnailTone: string;
}

export interface PublishedPost extends ScheduledPost {
  publishedAt: string;
  views: number;
  engagements: number;
  completionRatePct: number;
}

export interface ActivityEvent {
  id: string;
  kind: "IDEA" | "SCRIPT" | "SCHEDULE" | "REPORT" | "CLIENT" | "OPTIMISATION" | "PUBLISH";
  message: string;
  occurredAt: string;
}

export interface LearningInsight {
  id: string;
  headline: string;
  detail: string;
  confidence: "OBSERVED" | "EMERGING" | "STRONG";
  appliesToNextPlan: boolean;
}

export interface MetricValue {
  key: string;
  label: string;
  value: number;
  /** Formatting hint for the UI. */
  format: "COUNT" | "PERCENT" | "DURATION_SEC";
  deltaPct: number | null;
}

export interface AnalyticsSeriesPoint {
  date: string;
  value: number;
}

export interface AnalyticsSeries {
  key: string;
  label: string;
  points: AnalyticsSeriesPoint[];
}

export interface TopContentRow {
  contentItemId: string;
  title: string;
  platform: Platform;
  publishedAt: string;
  views: number;
  engagementRatePct: number;
  completionRatePct: number;
  pillarId: string;
}

export interface PillarPerformance {
  pillarId: string;
  pillarName: string;
  posts: number;
  avgViews: number;
  engagementRatePct: number;
}

export interface BestPostingTime {
  day: string;
  time: string;
  strengthPct: number;
  isPeak: boolean;
}

export interface AnalyticsSummary {
  periodLabel: string;
  isDemoData: boolean;
  headline: MetricValue[];
  secondary: MetricValue[];
  series: AnalyticsSeries[];
  topContent: TopContentRow[];
  pillarPerformance: PillarPerformance[];
  bestPostingTimes: BestPostingTime[];
}

export interface PipelineStage {
  key: "PLAN" | "IDEAS" | "SCRIPTS" | "CONTENT" | "PUBLISH" | "LEARN";
  label: string;
  description: string;
  count: number;
}

export interface QueueCounts {
  ideas: number;
  briefs: number;
  scripts: number;
  assetsReady: number;
  generating: number;
  needsReview: number;
  approved: number;
  scheduled: number;
  published: number;
  failed: number;
}

export interface DashboardView {
  workspace: Workspace;
  plan: {
    id: string;
    label: string;
    status: PlanStatus;
    objective: string;
    adherencePct: number;
    periodLabel: string;
  } | null;
  pipeline: PipelineStage[];
  queue: QueueCounts;
  approvals: ApprovalItem[];
  upcomingPosts: ScheduledPost[];
  recentActivity: ActivityEvent[];
  insights: LearningInsight[];
  metrics: MetricValue[];
  performanceSeries: AnalyticsSeries;
  clients: Client[];
  weekAtAGlance: { dayLabel: string; date: string; posts: ScheduledPost[] }[];
}

export interface ContentQueueView {
  counts: QueueCounts;
  items: ContentItem[];
}

export interface CalendarSlotPost extends ScheduledPost {
  hourLabel: string;
}

export interface CalendarView {
  rangeLabel: string;
  rangeStart: string;
  rangeEnd: string;
  hourRows: string[];
  days: { dayLabel: string; date: string; isToday: boolean; posts: CalendarSlotPost[] }[];
  scheduledQueue: ScheduledPost[];
  bestPostingTimes: BestPostingTime[];
}

export interface StudioView {
  contentItem: ContentItem;
  ideas: ContentIdea[];
  brief: ContentBrief | null;
  script: ScriptDraft;
  variants: ScriptVariant[];
  assets: MediaAsset[];
  captionStyles: { id: string; label: string; description: string }[];
  activeCaptionStyleId: string;
}

export interface IntegrationProvider {
  id: string;
  name: string;
  category: "SOCIAL" | "GENERATION";
  status: IntegrationStatus;
  accountLabel: string | null;
  lastSyncedAt: string | null;
  detail: string;
  /** False in the standalone frontend — no real OAuth exists here. */
  actionsEnabled: boolean;
}

/* -------------------------------------------------------------------------- */
/* Runtime validation for adapter payloads                                    */
/* -------------------------------------------------------------------------- */

export const platformSchema = z.enum(PLATFORMS);
export const contentStatusSchema = z.enum(CONTENT_STATUSES);
export const generationStatusSchema = z.enum(GENERATION_STATUSES);

export const scheduledPostSchema = z.object({
  id: z.string(),
  contentItemId: z.string(),
  title: z.string(),
  clientName: z.string(),
  platform: platformSchema,
  scheduledFor: z.string(),
  status: contentStatusSchema,
  thumbnailTone: z.string(),
});

export const generationJobSchema = z.object({
  generationJobId: z.string(),
  contentItemId: z.string(),
  status: generationStatusSchema,
  progress: z.number().min(0).max(100),
  previewUrl: z.string().nullable(),
  finalVideoUrl: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  qaStatus: z.enum(QA_STATUSES),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export const contentItemSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  title: z.string(),
  hook: z.string(),
  platform: platformSchema,
  pillarId: z.string(),
  status: contentStatusSchema,
  generation: generationJobSchema.nullable(),
  plannedPublishAt: z.string().nullable(),
  durationSec: z.number().nullable(),
  assetIds: z.array(z.string()),
  approvalRequired: z.boolean(),
  thumbnailTone: z.string(),
  updatedAt: z.string(),
});

/** Exported so the HTTP adapter can validate untrusted backend responses. */
export const responseSchemas = {
  contentItem: contentItemSchema,
  scheduledPost: scheduledPostSchema,
  generationJob: generationJobSchema,
} as const;
