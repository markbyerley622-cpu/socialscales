/**
 * HttpSocialScalesAdapter — integration-ready implementation.
 *
 * This is the file the SMMA backend team edits. Nothing else in the UI needs to
 * change to go from fixtures to real data: set SOCIAL_SCALES_DATA_MODE=http and
 * point NEXT_PUBLIC_SOCIAL_SCALES_API_URL at the backend.
 *
 * Every method already knows its endpoint and its response shape. The request
 * plumbing (`request`) is real; only the backend is missing. When a route is
 * not implemented yet the call surfaces a typed AdapterError rather than
 * silently returning fake data.
 *
 * Responses are validated with Zod where a schema exists, so a backend contract
 * drift fails loudly at the boundary instead of rendering a broken screen.
 */

import type { ZodType } from "zod";

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
import { responseSchemas } from "./contracts";
import type {
  AnalyticsSummary,
  BrandProfile,
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
  PlanHistoryEntry,
  ScriptDraft,
  StudioView,
  Workspace,
} from "./contracts";

export interface HttpAdapterOptions {
  baseUrl: string;
  /** Forwarded as `Authorization: Bearer <token>` when present. */
  token?: string;
  /** Next.js fetch revalidation window, in seconds. */
  revalidateSeconds?: number;
}

export class HttpSocialScalesAdapter implements SocialScalesAdapter {
  readonly mode = "http" as const;

  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly revalidateSeconds: number;

  constructor(options: HttpAdapterOptions) {
    if (!options.baseUrl) {
      throw new AdapterError(
        "NOT_CONFIGURED",
        "SOCIAL_SCALES_DATA_MODE=http requires NEXT_PUBLIC_SOCIAL_SCALES_API_URL to be set.",
      );
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.revalidateSeconds = options.revalidateSeconds ?? 30;
  }

  /* ---------------------------------------------------------------------- */

  private async request<T>(
    path: string,
    init: RequestInit & { schema?: ZodType<unknown> } = {},
  ): Promise<T> {
    const { schema, ...requestInit } = init;
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        ...requestInit,
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...requestInit.headers,
        },
        next: { revalidate: requestInit.method && requestInit.method !== "GET" ? 0 : this.revalidateSeconds },
      });
    } catch (cause) {
      throw new AdapterError("UPSTREAM_ERROR", `Could not reach the Social Scales backend at ${url}.`, cause);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AdapterError("UNAUTHORIZED", `Backend rejected the request to ${path}.`);
    }
    if (response.status === 404) {
      throw new AdapterError("NOT_FOUND", `Backend has no route for ${path}.`);
    }
    if (!response.ok) {
      throw new AdapterError("UPSTREAM_ERROR", `Backend returned ${response.status} for ${path}.`);
    }

    const payload: unknown = await response.json();

    if (schema) {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new AdapterError(
          "INVALID_RESPONSE",
          `Backend response for ${path} did not match the frontend contract.`,
          parsed.error.issues,
        );
      }
      return parsed.data as T;
    }

    return payload as T;
  }

  private query(params: Record<string, string | number | null | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined && value !== "") search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : "";
  }

  /* Workspace + onboarding ------------------------------------------------ */

  getWorkspace(): Promise<Workspace> {
    return this.request<Workspace>("/api/workspace");
  }

  getOnboardingState(): Promise<OnboardingState> {
    return this.request<OnboardingState>("/api/onboarding");
  }

  saveOnboardingDraft(draft: Partial<BrandProfile>): Promise<OnboardingState> {
    return this.request<OnboardingState>("/api/onboarding/draft", {
      method: "PATCH",
      body: JSON.stringify(draft),
    });
  }

  completeOnboarding(profile: Partial<BrandProfile>): Promise<{ planId: string }> {
    return this.request<{ planId: string }>("/api/onboarding/complete", {
      method: "POST",
      body: JSON.stringify(profile),
    });
  }

  /* Dashboard ------------------------------------------------------------- */

  getDashboard(): Promise<DashboardView> {
    return this.request<DashboardView>("/api/dashboard");
  }

  /* Clients --------------------------------------------------------------- */

  getClients(): Promise<Client[]> {
    return this.request<Client[]>("/api/clients");
  }

  getClient(id: string): Promise<Client | null> {
    return this.request<Client | null>(`/api/clients/${encodeURIComponent(id)}`);
  }

  /* Plan ------------------------------------------------------------------ */

  getActivePlan(clientId?: string): Promise<ContentPlan | null> {
    return this.request<ContentPlan | null>(`/api/plan${this.query({ clientId })}`);
  }

  getPlanHistory(clientId?: string): Promise<PlanHistoryEntry[]> {
    return this.request<PlanHistoryEntry[]>(`/api/plan/history${this.query({ clientId })}`);
  }

  createPlan(clientId?: string): Promise<ContentPlan> {
    return this.request<ContentPlan>("/api/plan", {
      method: "POST",
      body: JSON.stringify({ clientId }),
    });
  }

  approvePlan(planId: string): Promise<ContentPlan> {
    return this.request<ContentPlan>(`/api/plan/${encodeURIComponent(planId)}/approve`, { method: "POST" });
  }

  /* Content queue --------------------------------------------------------- */

  getContentQueue(filters: ContentQueueFilters = {}): Promise<ContentQueueView> {
    return this.request<ContentQueueView>(
      `/api/content${this.query({
        status: filters.status,
        clientId: filters.clientId,
        platform: filters.platform,
        search: filters.search,
      })}`,
    );
  }

  getContentItem(id: string): Promise<ContentItem | null> {
    return this.request<ContentItem | null>(`/api/content/${encodeURIComponent(id)}`, {
      schema: responseSchemas.contentItem.nullable(),
    });
  }

  /* Studio ---------------------------------------------------------------- */

  getStudio(contentItemId?: string): Promise<StudioView> {
    return this.request<StudioView>(`/api/studio${this.query({ contentItemId })}`);
  }

  getIdeas(clientId?: string): Promise<ContentIdea[]> {
    return this.request<ContentIdea[]>(`/api/ideas${this.query({ clientId })}`);
  }

  createContentIdea(clientId: string, title: string): Promise<ContentIdea> {
    return this.request<ContentIdea>("/api/ideas", {
      method: "POST",
      body: JSON.stringify({ clientId, title }),
    });
  }

  generateIdeas(clientId: string, count: number): Promise<ContentIdea[]> {
    return this.request<ContentIdea[]>("/api/ideas/generate", {
      method: "POST",
      body: JSON.stringify({ clientId, count }),
    });
  }

  updateScript(contentItemId: string, patch: ScriptPatch): Promise<ScriptDraft> {
    return this.request<ScriptDraft>(`/api/content/${encodeURIComponent(contentItemId)}/script`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  rewriteScript(contentItemId: string, directive: RewriteDirective): Promise<ScriptDraft> {
    return this.request<ScriptDraft>(`/api/content/${encodeURIComponent(contentItemId)}/script/rewrite`, {
      method: "POST",
      body: JSON.stringify({ directive }),
    });
  }

  /* Generation — the AAMP seam -------------------------------------------- */

  generateContent(contentItemId: string): Promise<GenerationJob> {
    return this.request<GenerationJob>(`/api/content/${encodeURIComponent(contentItemId)}/generate`, {
      method: "POST",
      schema: responseSchemas.generationJob,
    });
  }

  getGenerationJob(generationJobId: string): Promise<GenerationJob | null> {
    return this.request<GenerationJob | null>(
      `/api/generation-jobs/${encodeURIComponent(generationJobId)}`,
      { schema: responseSchemas.generationJob.nullable() },
    );
  }

  /* Approval + scheduling ------------------------------------------------- */

  approveContent(contentItemId: string): Promise<ContentItem> {
    return this.request<ContentItem>(`/api/content/${encodeURIComponent(contentItemId)}/approve`, {
      method: "POST",
      schema: responseSchemas.contentItem,
    });
  }

  scheduleContent(contentItemId: string, isoDateTime: string): Promise<ContentItem> {
    return this.request<ContentItem>(`/api/content/${encodeURIComponent(contentItemId)}/schedule`, {
      method: "POST",
      body: JSON.stringify({ scheduledFor: isoDateTime }),
      schema: responseSchemas.contentItem,
    });
  }

  /* Calendar -------------------------------------------------------------- */

  getCalendar(range: CalendarRange): Promise<CalendarView> {
    return this.request<CalendarView>(
      `/api/calendar${this.query({
        start: range.start,
        mode: range.mode,
        clientId: range.clientId,
        platform: range.platform,
      })}`,
    );
  }

  /* Analytics ------------------------------------------------------------- */

  getAnalytics(period: AnalyticsPeriod, filters: AnalyticsFilters = {}): Promise<AnalyticsSummary> {
    return this.request<AnalyticsSummary>(
      `/api/analytics${this.query({ period, clientId: filters.clientId, platform: filters.platform })}`,
    );
  }

  getInsights(): Promise<LearningInsight[]> {
    return this.request<LearningInsight[]>("/api/insights");
  }

  /* Integrations ---------------------------------------------------------- */

  getIntegrations(): Promise<IntegrationProvider[]> {
    return this.request<IntegrationProvider[]>("/api/integrations");
  }
}
