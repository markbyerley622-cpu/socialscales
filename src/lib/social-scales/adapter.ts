/**
 * The single seam between the Social Scales UI and any backend.
 *
 * Rule enforced by convention (and documented in INTEGRATION.md):
 *   React components -> view-model loaders -> SocialScalesAdapter -> backend
 *
 * Components never import a concrete adapter. They receive already-shaped view
 * models, so swapping MockSocialScalesAdapter for HttpSocialScalesAdapter is a
 * one-line config change rather than a UI rewrite.
 */

import type {
  AnalyticsSummary,
  BrandProfile,
  CalendarView,
  Client,
  ContentIdea,
  ContentItem,
  ContentPlan,
  ContentQueueView,
  ContentStatus,
  DashboardView,
  GenerationJob,
  IntegrationProvider,
  LearningInsight,
  OnboardingState,
  PlanHistoryEntry,
  Platform,
  ScriptDraft,
  StudioView,
  Workspace,
} from "./contracts";

export interface AnalyticsFilters {
  clientId?: string | null;
  platform?: Platform | null;
}

export interface ContentQueueFilters {
  status?: ContentStatus | null;
  clientId?: string | null;
  platform?: Platform | null;
  search?: string | null;
}

export interface CalendarRange {
  /** ISO date for the first day shown. Omit to let the backend pick "now". */
  start?: string;
  mode: "WEEK" | "MONTH";
  clientId?: string | null;
  platform?: Platform | null;
}

export type AnalyticsPeriod = "LAST_7_DAYS" | "LAST_30_DAYS" | "LAST_90_DAYS";

export interface ScriptPatch {
  workingTitle?: string;
  hook?: string;
  body?: string;
  cta?: string;
}

export type RewriteDirective =
  | "BRAND_VOICE"
  | "SHORTER"
  | "STRONGER_HOOK"
  | "MORE_DIRECT";

/**
 * Every read and write the frontend is allowed to perform.
 *
 * Keep this interface backend-agnostic: no Prisma types, no queue ids, no
 * provider SDK shapes, no HTTP details.
 */
export interface SocialScalesAdapter {
  readonly mode: "mock" | "http";

  /* Workspace + onboarding */
  getWorkspace(): Promise<Workspace>;
  getOnboardingState(): Promise<OnboardingState>;
  saveOnboardingDraft(draft: Partial<BrandProfile>): Promise<OnboardingState>;
  completeOnboarding(profile: Partial<BrandProfile>): Promise<{ planId: string }>;

  /* Dashboard */
  getDashboard(): Promise<DashboardView>;

  /* Clients */
  getClients(): Promise<Client[]>;
  getClient(id: string): Promise<Client | null>;

  /* Plan */
  getActivePlan(clientId?: string): Promise<ContentPlan | null>;
  getPlanHistory(clientId?: string): Promise<PlanHistoryEntry[]>;
  createPlan(clientId?: string): Promise<ContentPlan>;
  approvePlan(planId: string): Promise<ContentPlan>;

  /* Content queue */
  getContentQueue(filters?: ContentQueueFilters): Promise<ContentQueueView>;
  getContentItem(id: string): Promise<ContentItem | null>;

  /* Studio */
  getStudio(contentItemId?: string): Promise<StudioView>;
  getIdeas(clientId?: string): Promise<ContentIdea[]>;
  createContentIdea(clientId: string, title: string): Promise<ContentIdea>;
  generateIdeas(clientId: string, count: number): Promise<ContentIdea[]>;
  updateScript(contentItemId: string, patch: ScriptPatch): Promise<ScriptDraft>;
  rewriteScript(contentItemId: string, directive: RewriteDirective): Promise<ScriptDraft>;

  /* Generation — the future AAMP seam */
  generateContent(contentItemId: string): Promise<GenerationJob>;
  getGenerationJob(generationJobId: string): Promise<GenerationJob | null>;

  /* Approval + scheduling */
  approveContent(contentItemId: string): Promise<ContentItem>;
  scheduleContent(contentItemId: string, isoDateTime: string): Promise<ContentItem>;

  /* Calendar */
  getCalendar(range: CalendarRange): Promise<CalendarView>;

  /* Analytics + learning */
  getAnalytics(period: AnalyticsPeriod, filters?: AnalyticsFilters): Promise<AnalyticsSummary>;
  getInsights(): Promise<LearningInsight[]>;

  /* Integrations */
  getIntegrations(): Promise<IntegrationProvider[]>;
}

/* -------------------------------------------------------------------------- */
/* Typed errors                                                               */
/* -------------------------------------------------------------------------- */

export type AdapterErrorCode =
  | "NOT_CONFIGURED"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly detail?: unknown;

  constructor(code: AdapterErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.detail = detail;
  }
}

export function isAdapterError(error: unknown): error is AdapterError {
  return error instanceof AdapterError;
}
