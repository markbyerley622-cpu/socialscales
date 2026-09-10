import { addDays, differenceInHours, startOfDay, startOfWeek } from "date-fns";

import { prisma } from "@/server/db";
import {
  AccountStatus,
  ApprovalState,
  LearningStatus,
  MetricSource,
  PostPlatformStatus,
  PostStatus,
  RenderStatus,
  type Platform as DbPlatform,
} from "@/generated/prisma/enums";
import { getCurrentUser } from "@/server/auth/session";
import { enqueueRender } from "@/server/rendering";
import { approvePost, schedulePost } from "@/server/services/post-service";
import { createContentPlan } from "@/server/content-director";
import { generateStrategy } from "@/server/strategy";

import {
  AdapterError,
  type AnalyticsFilters,
  type AnalyticsPeriod,
  type CalendarRange,
  type ContentQueueFilters,
  type ScriptPatch,
  type SocialScalesAdapter,
} from "./adapter";
import type {
  ActivityEvent,
  AnalyticsSummary,
  ApprovalItem,
  BrandProfile,
  CalendarView,
  Client,
  ContentIdea,
  ContentItem,
  ContentPillar,
  ContentPlan,
  ContentQueueView,
  ContentStatus,
  DashboardView,
  GenerationJob,
  IntegrationProvider,
  LearningInsight,
  MetricValue,
  OnboardingState,
  Platform,
  PlanHistoryEntry,
  PlannedBrief,
  QueueCounts,
  ScheduledPost,
  ScriptDraft,
  StudioView,
  Workspace,
} from "./contracts";

/**
 * The Social Scales dashboard, served directly from this app's own database.
 *
 * This is the third adapter `INTEGRATION.md` describes: no HTTP hop, no second
 * service. The dashboard's vocabulary and this backend's schema are different on
 * purpose — the UI speaks about clients, content items and generation jobs, and
 * the backend speaks about projects, posts and render jobs — so this file is the
 * whole of the translation, and it is the only place the two vocabularies meet.
 *
 * The naming map, in one place:
 *
 *   Client          ← Project        (a Project *is* a brand; see docs/DOMAIN.md)
 *   BrandProfile    ← Brand + BusinessObjective + AudienceSegment
 *   ContentPlan     ← ContentPlan + ContentBrief + ContentPillar
 *   ContentItem     ← Post           (with its asset, variant and destinations)
 *   ScheduledPost   ← PostPlatform   (one per destination)
 *   GenerationJob   ← RenderJob
 *   LearningInsight ← Learning
 *   ContentIdea     ← Recommendation
 *   IntegrationProvider ← SocialAccount
 *
 * One honesty rule runs through it: `isDemoData` is true whenever the numbers
 * behind a view are simulated. The dashboard renders a badge from that flag, and
 * it is the difference between a chart that means something and one that does
 * not.
 */
export class PrismaSocialScalesAdapter implements SocialScalesAdapter {
  readonly mode = "prisma" as const;

  // -------------------------------------------------------------------------
  // Workspace and onboarding
  // -------------------------------------------------------------------------

  async getWorkspace(): Promise<Workspace> {
    const [workspace, user, simulated] = await Promise.all([
      prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } }),
      getCurrentUser(),
      this.analyticsAreSimulated(),
    ]);

    return {
      id: workspace?.id ?? "workspace",
      name: workspace?.name ?? "Social Scales",
      tagline: "Strategy, content, scheduling and learning in one workspace.",
      plan: "Internal",
      ownerName: user?.name ?? "Operator",
      ownerRole: user?.role ?? "OWNER",
      isDemoData: simulated,
    };
  }

  async getOnboardingState(): Promise<OnboardingState> {
    const project = await prisma.project.findFirst({
      orderBy: { createdAt: "asc" },
      include: {
        brand: true,
        objectives: true,
        audiences: true,
        accounts: true,
        strategies: { where: { status: "ACTIVE" }, take: 1 },
      },
    });

    if (!project) {
      return {
        clientId: null,
        complete: false,
        currentStep: "BUSINESS",
        completedSteps: [],
        draft: {},
      };
    }

    // A step counts as done when the data behind it actually exists, not when
    // someone clicked past it.
    const completed: OnboardingState["completedSteps"] = [];
    if (project.brand) completed.push("BUSINESS");
    if (project.objectives.length > 0) completed.push("GOALS");
    if (project.audiences.length > 0) completed.push("AUDIENCE");
    if (project.brand?.tone) completed.push("BRAND_VOICE");
    if (project.accounts.length > 0) completed.push("PLATFORMS");
    if (project.strategies.length > 0) completed.push("FIRST_STRATEGY");

    const order: OnboardingState["completedSteps"] = [
      "BUSINESS",
      "GOALS",
      "AUDIENCE",
      "BRAND_VOICE",
      "PLATFORMS",
      "FIRST_STRATEGY",
    ];
    const next = order.find((step) => !completed.includes(step));

    return {
      clientId: project.id,
      complete: next === undefined,
      currentStep: next ?? "FIRST_STRATEGY",
      completedSteps: completed,
      draft: this.brandProfileOf(project),
    };
  }

  async saveOnboardingDraft(draft: Partial<BrandProfile>): Promise<OnboardingState> {
    const project = await prisma.project.findFirst({ orderBy: { createdAt: "asc" } });
    if (!project) {
      throw new AdapterError(
        "NOT_CONFIGURED",
        "There is no project yet. Create one in the operator console at /ops/projects first.",
      );
    }

    await prisma.brand.upsert({
      where: { projectId: project.id },
      create: {
        projectId: project.id,
        audience: draft.idealCustomer ?? "not stated",
        tone: draft.toneOfVoice?.join(", ") ?? "not stated",
        valueProp: draft.offer ?? "not stated",
        primaryCta: draft.primaryCta ?? "Link in bio",
        website: draft.website ?? null,
        industry: draft.niche ?? null,
        productsServices: draft.productsServices ?? [],
        competitors: draft.competitors ?? [],
        prohibitedTopics: draft.claimsToAvoid ?? [],
      },
      update: {
        ...(draft.idealCustomer ? { audience: draft.idealCustomer } : {}),
        ...(draft.toneOfVoice ? { tone: draft.toneOfVoice.join(", ") } : {}),
        ...(draft.offer ? { valueProp: draft.offer } : {}),
        ...(draft.primaryCta ? { primaryCta: draft.primaryCta } : {}),
        ...(draft.website !== undefined ? { website: draft.website } : {}),
        ...(draft.niche ? { industry: draft.niche } : {}),
        ...(draft.productsServices ? { productsServices: draft.productsServices } : {}),
        ...(draft.competitors ? { competitors: draft.competitors } : {}),
        ...(draft.claimsToAvoid ? { prohibitedTopics: draft.claimsToAvoid } : {}),
      },
    });

    return this.getOnboardingState();
  }

  async completeOnboarding(profile: Partial<BrandProfile>): Promise<{ planId: string }> {
    await this.saveOnboardingDraft(profile);

    const project = await prisma.project.findFirstOrThrow({
      orderBy: { createdAt: "asc" },
      select: { id: true, workspaceId: true },
    });

    // Onboarding finishes by producing a real strategy and a real plan through
    // the same engines the console uses — not by flipping a flag.
    const strategy = await generateStrategy({
      workspaceId: project.workspaceId,
      projectId: project.id,
      activate: true,
    });
    if (!strategy.ok) {
      throw new AdapterError("UPSTREAM_ERROR", `Could not draft a strategy: ${strategy.reason}`);
    }

    const plan = await createContentPlan({
      workspaceId: project.workspaceId,
      projectId: project.id,
      days: 14,
      activate: true,
    });
    if (!plan.ok) {
      throw new AdapterError("UPSTREAM_ERROR", `Could not build a plan: ${plan.reason}`);
    }

    return { planId: plan.planId };
  }

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------

  async getClients(): Promise<Client[]> {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        brand: true,
        accounts: true,
        plans: { where: { status: "ACTIVE" }, take: 1 },
        strategies: { where: { status: "ACTIVE" }, take: 1 },
      },
    });

    const weekAgo = addDays(new Date(), -7);

    return Promise.all(
      projects.map(async (project) => {
        const [postsThisWeek, awaitingApproval, upcoming, lastActivity] = await Promise.all([
          prisma.postPlatform.count({
            where: { post: { projectId: project.id }, publishedAt: { gte: weekAgo } },
          }),
          prisma.post.count({
            where: { projectId: project.id, approvalState: ApprovalState.PENDING },
          }),
          prisma.post.count({
            where: { projectId: project.id, scheduledFor: { gt: new Date() } },
          }),
          prisma.activityLog.findFirst({
            where: { projectId: project.id },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          }),
        ]);

        const connected = project.accounts.filter(
          (account) => account.status === AccountStatus.CONNECTED,
        );

        return {
          id: project.id,
          name: project.name,
          initials: initialsOf(project.name),
          niche: project.brand?.industry ?? project.brand?.audience ?? "Not stated",
          status: project.status === "ACTIVE" ? "ACTIVE" : "PAUSED",
          onboardingComplete: project.strategies.length > 0,
          connectedPlatforms: connected
            .map((account) => toUiPlatform(account.platform))
            .filter((platform): platform is Platform => platform !== null),
          planStatus: project.plans.length > 0 ? "ACTIVE" : "DRAFT",
          postsThisWeek,
          awaitingApproval,
          upcomingPosts: upcoming,
          // Deliberately null: a trend needs two comparable real periods, and
          // nothing here has published for real yet. A number would be invented.
          engagementTrendPct: null,
          health:
            connected.length === 0
              ? "AT_RISK"
              : awaitingApproval > 3
                ? "ATTENTION"
                : "HEALTHY",
          lastActivityAt: (lastActivity?.createdAt ?? project.updatedAt).toISOString(),
        } satisfies Client;
      }),
    );
  }

  async getClient(id: string): Promise<Client | null> {
    const clients = await this.getClients();
    return clients.find((client) => client.id === id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------------

  async getActivePlan(clientId?: string): Promise<ContentPlan | null> {
    const projectId = clientId ?? (await this.defaultProjectId());
    if (!projectId) return null;

    const plan = await prisma.contentPlan.findFirst({
      where: { projectId, status: "ACTIVE" },
      orderBy: { version: "desc" },
      include: {
        strategy: { include: { targetAudience: true } },
        briefs: { orderBy: { sequence: "asc" } },
      },
    });
    if (!plan) return null;

    const pillars = await prisma.contentPillar.findMany({
      where: { projectId },
      orderBy: { name: "asc" },
    });

    const fulfilled = plan.briefs.filter((brief) => brief.status === "FULFILLED").length;

    return {
      id: plan.id,
      clientId: projectId,
      label: `Plan v${plan.version}`,
      status: "ACTIVE",
      periodStart: plan.startsOn.toISOString(),
      periodEnd: plan.endsOn.toISOString(),
      objective: plan.strategy.summary,
      audienceSummary: plan.strategy.targetAudience?.name ?? "Not narrowed",
      cadence: cadenceLabel(plan.rationale),
      pillars: pillars.map((pillar, index) => ({
        id: pillar.slug,
        name: pillar.name,
        description: pillar.description ?? "",
        sharePct: shareOf(plan.briefs, pillar.slug),
        colorToken: PILLAR_TOKENS[index % PILLAR_TOKENS.length]!,
      })) satisfies ContentPillar[],
      briefs: plan.briefs.map((brief) => ({
        id: brief.id,
        dayLabel: brief.plannedFor
          ? brief.plannedFor.toLocaleDateString("en-GB", { weekday: "short" })
          : "—",
        scheduledFor: (brief.plannedFor ?? plan.startsOn).toISOString(),
        platform: toUiPlatform(brief.platforms[0]) ?? "TIKTOK",
        pillarId: brief.pillarSlug ?? "general",
        title: brief.workingTitle,
        angle: brief.angle,
        status: briefStatusToContentStatus(brief.status),
      })) satisfies PlannedBrief[],
      adherencePct:
        plan.briefs.length === 0 ? 0 : Math.round((fulfilled / plan.briefs.length) * 100),
      createdAt: plan.createdAt.toISOString(),
    };
  }

  async getPlanHistory(clientId?: string): Promise<PlanHistoryEntry[]> {
    const projectId = clientId ?? (await this.defaultProjectId());
    if (!projectId) return [];

    const plans = await prisma.contentPlan.findMany({
      where: { projectId },
      orderBy: { version: "desc" },
      include: { briefs: { select: { status: true, postId: true } } },
    });

    return plans.map((plan) => {
      const fulfilled = plan.briefs.filter((brief) => brief.status === "FULFILLED").length;
      return {
        id: plan.id,
        label: `Plan v${plan.version}`,
        periodStart: plan.startsOn.toISOString(),
        periodEnd: plan.endsOn.toISOString(),
        adherencePct:
          plan.briefs.length === 0 ? 0 : Math.round((fulfilled / plan.briefs.length) * 100),
        postsPublished: fulfilled,
        headline: plan.summary,
      };
    });
  }

  async createPlan(clientId?: string): Promise<ContentPlan> {
    const projectId = clientId ?? (await this.defaultProjectId());
    if (!projectId) {
      throw new AdapterError("NOT_FOUND", "There is no project to plan for.");
    }
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { workspaceId: true },
    });

    const result = await createContentPlan({
      workspaceId: project.workspaceId,
      projectId,
      days: 14,
      activate: true,
    });
    if (!result.ok) {
      throw new AdapterError("UPSTREAM_ERROR", result.reason);
    }

    const plan = await this.getActivePlan(projectId);
    if (!plan) throw new AdapterError("UPSTREAM_ERROR", "The plan was created but could not be read back.");
    return plan;
  }

  async approvePlan(planId: string): Promise<ContentPlan> {
    const plan = await prisma.contentPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { projectId: true },
    });
    const active = await this.getActivePlan(plan.projectId);
    if (!active) throw new AdapterError("NOT_FOUND", "That plan no longer exists.");
    return active;
  }

  // -------------------------------------------------------------------------
  // Content queue
  // -------------------------------------------------------------------------

  async getContentQueue(filters?: ContentQueueFilters): Promise<ContentQueueView> {
    const projectId = filters?.clientId ?? undefined;

    const posts = await prisma.post.findMany({
      where: {
        ...(projectId ? { projectId } : {}),
        ...(filters?.search
          ? { variant: { hook: { contains: filters.search, mode: "insensitive" } } }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: POST_INCLUDE,
    });

    const items = posts
      .map((post) => this.toContentItem(post))
      .filter((item) => (filters?.platform ? item.platform === filters.platform : true))
      .filter((item) => (filters?.status ? item.status === filters.status : true));

    // The tab badges want the counts for the whole queue, not this page of it.
    const all = projectId
      ? posts
      : await prisma.post.findMany({ orderBy: { updatedAt: "desc" }, include: POST_INCLUDE });

    return { counts: this.countQueue(all.map((post) => this.toContentItem(post))), items };
  }

  async getContentItem(id: string): Promise<ContentItem | null> {
    const post = await prisma.post.findUnique({ where: { id }, include: POST_INCLUDE });
    return post ? this.toContentItem(post) : null;
  }

  // -------------------------------------------------------------------------
  // Studio, script and ideas
  // -------------------------------------------------------------------------

  async getStudio(contentItemId?: string): Promise<StudioView> {
    const post = contentItemId
      ? await prisma.post.findUnique({ where: { id: contentItemId }, include: POST_INCLUDE })
      : await prisma.post.findFirst({ orderBy: { updatedAt: "desc" }, include: POST_INCLUDE });

    if (!post) {
      throw new AdapterError(
        "NOT_FOUND",
        "There is no content to open in the studio yet. Upload an asset and draft a variant in the console first.",
      );
    }

    const item = this.toContentItem(post);
    const [ideas, siblings, assets] = await Promise.all([
      this.getIdeas(post.projectId),
      prisma.contentVariant.findMany({
        where: { assetId: post.assetId },
        orderBy: [{ isControl: "desc" }, { createdAt: "asc" }],
      }),
      prisma.contentAsset.findMany({
        where: { projectId: post.projectId },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    ]);

    return {
      contentItem: item,
      ideas,
      brief: null,
      script: this.toScriptDraft(post),
      variants: siblings.map((variant) => ({
        id: variant.id,
        label: variant.label,
        angle: variant.hook,
        selected: variant.id === post.variantId,
      })),
      assets: assets.map((asset) => ({
        id: asset.id,
        clientId: asset.projectId,
        fileName: asset.originalFilename,
        kind: asset.kind === "IMAGE" ? "IMAGE" : "VIDEO",
        durationSec: asset.durationSeconds,
        thumbnailTone: toneFor(asset.id),
        selected: asset.id === post.assetId,
        addedAt: asset.createdAt.toISOString(),
      })),
      captionStyles: CAPTION_STYLES,
      activeCaptionStyleId: CAPTION_STYLES[0]!.id,
    };
  }

  async getIdeas(clientId?: string): Promise<ContentIdea[]> {
    const projectId = clientId ?? (await this.defaultProjectId());
    if (!projectId) return [];

    const recommendations = await prisma.recommendation.findMany({
      where: { projectId, status: "OPEN" },
      orderBy: { createdAt: "desc" },
      take: 24,
    });

    return recommendations.map((row) => ({
      id: row.id,
      clientId: projectId,
      title: row.title,
      rationale: row.rationale,
      pillarId: "general",
      platform: "TIKTOK",
      source: row.kind === "EXPERIMENT" ? "TRENDING" : "FOR_YOU",
      potential:
        row.confidence === "HIGH" ? "HIGH" : row.confidence === "MEDIUM" ? "MEDIUM" : "EXPLORATORY",
      thumbnailTone: toneFor(row.id),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async createContentIdea(clientId: string, title: string): Promise<ContentIdea> {
    const row = await prisma.recommendation.create({
      data: {
        projectId: clientId,
        kind: "DOUBLE_DOWN",
        title,
        rationale: "Added by hand in the studio.",
        evidence: {},
        generatedBy: "operator",
      },
    });
    return {
      id: row.id,
      clientId,
      title: row.title,
      rationale: row.rationale,
      pillarId: "general",
      platform: "TIKTOK",
      source: "SAVED",
      potential: "EXPLORATORY",
      thumbnailTone: toneFor(row.id),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async generateIdeas(clientId: string, count: number): Promise<ContentIdea[]> {
    const { refreshRecommendations } = await import("@/server/learning/recommendations");
    await refreshRecommendations(clientId);
    return (await this.getIdeas(clientId)).slice(0, count);
  }

  async updateScript(contentItemId: string, patch: ScriptPatch): Promise<ScriptDraft> {
    const post = await prisma.post.findUniqueOrThrow({
      where: { id: contentItemId },
      include: POST_INCLUDE,
    });

    await prisma.contentVariant.update({
      where: { id: post.variantId },
      data: {
        ...(patch.hook !== undefined ? { hook: patch.hook } : {}),
        ...(patch.body !== undefined ? { caption: patch.body } : {}),
        ...(patch.cta !== undefined ? { cta: patch.cta } : {}),
      },
    });

    const updated = await prisma.post.findUniqueOrThrow({
      where: { id: contentItemId },
      include: POST_INCLUDE,
    });
    return this.toScriptDraft(updated);
  }

  async rewriteScript(contentItemId: string): Promise<ScriptDraft> {
    // Deliberately not wired to the AI boundary yet: a rewrite would need its own
    // registered, versioned prompt, and inventing one here would put model output
    // into the system outside the orchestration layer every other generation
    // goes through. The script is returned unchanged rather than silently faked.
    const post = await prisma.post.findUniqueOrThrow({
      where: { id: contentItemId },
      include: POST_INCLUDE,
    });
    return this.toScriptDraft(post);
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  async generateContent(contentItemId: string): Promise<GenerationJob> {
    const post = await prisma.post.findUniqueOrThrow({
      where: { id: contentItemId },
      select: { variantId: true },
    });

    const queued = await enqueueRender({ variantId: post.variantId });
    const job = await prisma.renderJob.findUniqueOrThrow({ where: { id: queued.renderJobId } });
    return this.toGenerationJob(job, contentItemId);
  }

  async getGenerationJob(generationJobId: string): Promise<GenerationJob | null> {
    const job = await prisma.renderJob.findUnique({ where: { id: generationJobId } });
    if (!job) return null;

    const post = await prisma.post.findFirst({
      where: { variantId: job.variantId },
      select: { id: true },
    });
    return this.toGenerationJob(job, post?.id ?? job.variantId);
  }

  // -------------------------------------------------------------------------
  // Approval and scheduling
  // -------------------------------------------------------------------------

  async approveContent(contentItemId: string): Promise<ContentItem> {
    const user = await getCurrentUser();
    if (!user) throw new AdapterError("UNAUTHORIZED", "Sign in to approve content.");

    await approvePost({ postId: contentItemId, userId: user.id });
    const post = await prisma.post.findUniqueOrThrow({
      where: { id: contentItemId },
      include: POST_INCLUDE,
    });
    return this.toContentItem(post);
  }

  async scheduleContent(contentItemId: string, isoDateTime: string): Promise<ContentItem> {
    const user = await getCurrentUser();
    if (!user) throw new AdapterError("UNAUTHORIZED", "Sign in to schedule content.");

    await schedulePost({
      postId: contentItemId,
      scheduledFor: new Date(isoDateTime),
      userId: user.id,
    });
    const post = await prisma.post.findUniqueOrThrow({
      where: { id: contentItemId },
      include: POST_INCLUDE,
    });
    return this.toContentItem(post);
  }

  // -------------------------------------------------------------------------
  // Calendar
  // -------------------------------------------------------------------------

  async getCalendar(range: CalendarRange): Promise<CalendarView> {
    const anchor = range.start ? new Date(range.start) : new Date();
    const mode = range.mode === "MONTH" ? "month" : "week";
    const rangeStart =
      mode === "month"
        ? startOfDay(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
        : startOfWeek(anchor, { weekStartsOn: 1 });
    const dayCount =
      mode === "month"
        ? new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()
        : 7;
    const rangeEnd = addDays(rangeStart, dayCount);

    const destinations = await prisma.postPlatform.findMany({
      where: {
        post: {
          ...(range.clientId ? { projectId: range.clientId } : {}),
          scheduledFor: { gte: rangeStart, lt: rangeEnd },
        },
        ...(range.platform ? { platform: range.platform as DbPlatform } : {}),
      },
      include: DESTINATION_INCLUDE,
      orderBy: { post: { scheduledFor: "asc" } },
    });

    const today = startOfDay(new Date()).getTime();
    const days = Array.from({ length: dayCount }, (_, index) => {
      const date = addDays(rangeStart, index);
      const posts = destinations
        .filter(
          (row) =>
            row.post.scheduledFor !== null &&
            startOfDay(row.post.scheduledFor).getTime() === startOfDay(date).getTime(),
        )
        .map((row) => ({
          ...this.toScheduledPost(row),
          hourLabel: row.post.scheduledFor!.toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        }));

      return {
        dayLabel: date.toLocaleDateString("en-GB", { weekday: "short" }),
        date: date.toISOString(),
        isToday: startOfDay(date).getTime() === today,
        posts,
      };
    });

    const queued = await prisma.postPlatform.findMany({
      where: {
        post: { scheduledFor: { gte: new Date() } },
        status: PostPlatformStatus.PENDING,
      },
      include: DESTINATION_INCLUDE,
      orderBy: { post: { scheduledFor: "asc" } },
      take: 20,
    });

    return {
      rangeLabel:
        mode === "month"
          ? rangeStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" })
          : `${rangeStart.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${addDays(rangeStart, 6).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`,
      rangeStart: rangeStart.toISOString(),
      rangeEnd: rangeEnd.toISOString(),
      hourRows: ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"],
      days,
      scheduledQueue: queued.map((row) => this.toScheduledPost(row)),
      // Empty on purpose: a "best time to post" needs this account's own
      // published results, and nothing has published for real yet. A shipped
      // table of generic times would be a global prior wearing local clothes.
      bestPostingTimes: [],
    };
  }

  // -------------------------------------------------------------------------
  // Analytics and insights
  // -------------------------------------------------------------------------

  async getAnalytics(
    period: AnalyticsPeriod,
    filters?: AnalyticsFilters,
  ): Promise<AnalyticsSummary> {
    const days = period === "LAST_7_DAYS" ? 7 : period === "LAST_90_DAYS" ? 90 : 30;
    const since = addDays(new Date(), -days);

    const snapshots = await prisma.analyticsSnapshot.findMany({
      where: {
        capturedAt: { gte: since },
        ...(filters?.clientId ? { postPlatform: { post: { projectId: filters.clientId } } } : {}),
        ...(filters?.platform ? { postPlatform: { platform: filters.platform as DbPlatform } } : {}),
      },
      include: {
        postPlatform: {
          include: {
            post: { include: { variant: true, asset: true, project: true } },
          },
        },
      },
      orderBy: { capturedAt: "asc" },
    });

    const simulated =
      snapshots.length > 0 && snapshots.every((row) => row.source === MetricSource.SIMULATED);

    const views = snapshots.reduce((sum, row) => sum + row.views, 0);
    const likes = snapshots.reduce((sum, row) => sum + row.likes, 0);
    const comments = snapshots.reduce((sum, row) => sum + row.comments, 0);
    const shares = snapshots.reduce((sum, row) => sum + row.shares, 0);
    const engagements = likes + comments + shares;

    const byDay = new Map<string, number>();
    for (const row of snapshots) {
      const key = startOfDay(row.capturedAt).toISOString();
      byDay.set(key, (byDay.get(key) ?? 0) + row.views);
    }

    const headline: MetricValue[] = [
      { key: "views", label: "Views", value: views, format: "COUNT", deltaPct: null },
      { key: "engagements", label: "Engagements", value: engagements, format: "COUNT", deltaPct: null },
      {
        key: "engagementRate",
        label: "Engagement rate",
        value: views === 0 ? 0 : (engagements / views) * 100,
        format: "PERCENT",
        deltaPct: null,
      },
      { key: "posts", label: "Posts measured", value: new Set(snapshots.map((r) => r.postPlatformId)).size, format: "COUNT", deltaPct: null },
    ];

    return {
      periodLabel:
        period === "LAST_7_DAYS"
          ? "Last 7 days"
          : period === "LAST_90_DAYS"
            ? "Last 90 days"
            : "Last 30 days",
      // The badge the dashboard renders from this is the difference between a
      // chart that means something and one that does not.
      isDemoData: simulated,
      headline,
      secondary: [
        { key: "likes", label: "Likes", value: likes, format: "COUNT", deltaPct: null },
        { key: "comments", label: "Comments", value: comments, format: "COUNT", deltaPct: null },
        { key: "shares", label: "Shares", value: shares, format: "COUNT", deltaPct: null },
      ],
      series: [
        {
          key: "views",
          label: "Views",
          points: [...byDay.entries()].map(([date, value]) => ({ date, value })),
        },
      ],
      topContent: topRows(snapshots),
      pillarPerformance: [],
      bestPostingTimes: [],
    };
  }

  async getInsights(): Promise<LearningInsight[]> {
    const learnings = await prisma.learning.findMany({
      where: { status: { in: [LearningStatus.EMERGING, LearningStatus.SUPPORTED] } },
      orderBy: { updatedAt: "desc" },
      take: 8,
    });

    return learnings.map((learning) => ({
      id: learning.id,
      headline: learning.claim,
      detail: `${learning.supportingCount} supporting, ${learning.contradictingCount} contradicting${
        learning.sampleSize > 0 ? `, across ${learning.sampleSize} observations` : ""
      }.`,
      confidence:
        learning.status === LearningStatus.SUPPORTED
          ? "STRONG"
          : learning.status === LearningStatus.EMERGING
            ? "EMERGING"
            : "OBSERVED",
      appliesToNextPlan: learning.status === LearningStatus.SUPPORTED,
    }));
  }

  // -------------------------------------------------------------------------
  // Integrations
  // -------------------------------------------------------------------------

  async getIntegrations(): Promise<IntegrationProvider[]> {
    const accounts = await prisma.socialAccount.findMany({ orderBy: { platform: "asc" } });

    return accounts.map((account) => ({
      id: account.id,
      name: `${account.platform} — ${account.handle}`,
      category: "SOCIAL",
      status: toIntegrationStatus(account.status),
      accountLabel: account.handle,
      lastSyncedAt: account.lastCheckedAt?.toISOString() ?? null,
      detail:
        account.status === AccountStatus.CONNECTED
          ? "Connected. Publishing runs through the worker's dedicated browser profile."
          : "Not connected. Connect it from the operator console at /ops/accounts.",
      // Connecting drives a real browser and needs a person at the keyboard, so
      // it happens in the console rather than here.
      actionsEnabled: false,
    }));
  }

  // -------------------------------------------------------------------------
  // Dashboard — one composed read, as INTEGRATION.md asks for
  // -------------------------------------------------------------------------

  async getDashboard(): Promise<DashboardView> {
    const [workspace, clients, insights, analytics] = await Promise.all([
      this.getWorkspace(),
      this.getClients(),
      this.getInsights(),
      this.getAnalytics("LAST_30_DAYS"),
    ]);

    const projectId = clients[0]?.id ?? null;
    const plan = projectId ? await this.getActivePlan(projectId) : null;

    const [posts, pendingPosts, activity] = await Promise.all([
      prisma.post.findMany({ orderBy: { updatedAt: "desc" }, take: 200, include: POST_INCLUDE }),
      prisma.post.findMany({
        where: { approvalState: ApprovalState.PENDING },
        orderBy: { createdAt: "asc" },
        take: 8,
        include: POST_INCLUDE,
      }),
      prisma.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    ]);

    const items = posts.map((post) => this.toContentItem(post));
    const counts = this.countQueue(items);

    const upcoming = await prisma.postPlatform.findMany({
      where: { post: { scheduledFor: { gte: new Date() } } },
      include: DESTINATION_INCLUDE,
      orderBy: { post: { scheduledFor: "asc" } },
      take: 8,
    });

    const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
    const weekDestinations = await prisma.postPlatform.findMany({
      where: {
        post: { scheduledFor: { gte: weekStart, lt: addDays(weekStart, 7) } },
      },
      include: DESTINATION_INCLUDE,
    });

    return {
      workspace,
      plan: plan
        ? {
            id: plan.id,
            label: plan.label,
            status: plan.status,
            objective: plan.objective,
            adherencePct: plan.adherencePct,
            periodLabel: `${new Date(plan.periodStart).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${new Date(plan.periodEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`,
          }
        : null,
      pipeline: [
        { key: "PLAN", label: "Plan", description: "Briefs commissioned", count: plan?.briefs.length ?? 0 },
        { key: "IDEAS", label: "Ideas", description: "Open recommendations", count: counts.ideas },
        { key: "SCRIPTS", label: "Scripts", description: "Drafted variants", count: counts.scripts },
        { key: "CONTENT", label: "Content", description: "Rendered and ready", count: counts.assetsReady },
        { key: "PUBLISH", label: "Publish", description: "Scheduled or live", count: counts.scheduled + counts.published },
        { key: "LEARN", label: "Learn", description: "Standing learnings", count: insights.length },
      ],
      queue: counts,
      approvals: pendingPosts.map((post) => this.toApprovalItem(post)),
      upcomingPosts: upcoming.map((row) => this.toScheduledPost(row)),
      recentActivity: activity.map((row) => ({
        id: row.id,
        kind: activityKind(row.action),
        message: row.message,
        occurredAt: row.createdAt.toISOString(),
      })) satisfies ActivityEvent[],
      insights,
      metrics: analytics.headline,
      performanceSeries: analytics.series[0] ?? { key: "views", label: "Views", points: [] },
      clients,
      weekAtAGlance: Array.from({ length: 7 }, (_, index) => {
        const date = addDays(weekStart, index);
        return {
          dayLabel: date.toLocaleDateString("en-GB", { weekday: "short" }),
          date: date.toISOString(),
          posts: weekDestinations
            .filter(
              (row) =>
                row.post.scheduledFor !== null &&
                startOfDay(row.post.scheduledFor).getTime() === startOfDay(date).getTime(),
            )
            .map((row) => this.toScheduledPost(row)),
        };
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Mapping helpers
  // -------------------------------------------------------------------------

  private async defaultProjectId(): Promise<string | null> {
    const project = await prisma.project.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    return project?.id ?? null;
  }

  private async analyticsAreSimulated(): Promise<boolean> {
    const real = await prisma.analyticsSnapshot.count({
      where: { source: { not: MetricSource.SIMULATED } },
    });
    const any = await prisma.analyticsSnapshot.count();
    return any > 0 && real === 0;
  }

  private brandProfileOf(project: {
    name: string;
    brand: { audience: string; tone: string; valueProp: string; primaryCta: string; website: string | null; industry: string | null; productsServices: string[]; competitors: string[]; prohibitedTopics: string[] } | null;
    objectives: Array<{ kpi: string }>;
    accounts: Array<{ platform: DbPlatform }>;
  }): Partial<BrandProfile> {
    if (!project.brand) return { businessName: project.name };
    return {
      businessName: project.name,
      website: project.brand.website,
      niche: project.brand.industry ?? "",
      offer: project.brand.valueProp,
      productsServices: project.brand.productsServices,
      idealCustomer: project.brand.audience,
      businessObjective: project.objectives[0]?.kpi ?? "",
      contentGoals: project.objectives.map((objective) => objective.kpi),
      primaryCta: project.brand.primaryCta,
      toneOfVoice: project.brand.tone.split(",").map((part) => part.trim()).filter(Boolean),
      claimsToAvoid: project.brand.prohibitedTopics,
      competitors: project.brand.competitors,
      platforms: project.accounts
        .map((account) => toUiPlatform(account.platform))
        .filter((platform): platform is Platform => platform !== null),
    };
  }

  private toContentItem(post: PostWithRelations): ContentItem {
    const destination = post.targets[0] ?? null;
    return {
      id: post.id,
      clientId: post.projectId,
      clientName: post.project.name,
      title: post.asset.title,
      hook: post.variant.hook,
      platform: destination ? (toUiPlatform(destination.platform) ?? "TIKTOK") : "TIKTOK",
      pillarId: "general",
      status: postToContentStatus(post),
      generation: post.asset.renderedBy
        ? this.toGenerationJob(post.asset.renderedBy, post.id)
        : null,
      plannedPublishAt: post.scheduledFor?.toISOString() ?? null,
      durationSec: post.asset.durationSeconds,
      assetIds: [post.assetId],
      approvalRequired: post.approvalState === ApprovalState.PENDING,
      thumbnailTone: toneFor(post.id),
      updatedAt: post.updatedAt.toISOString(),
    };
  }

  private toApprovalItem(post: PostWithRelations): ApprovalItem {
    const destination = post.targets[0] ?? null;
    return {
      id: post.id,
      contentItemId: post.id,
      title: post.asset.title,
      clientName: post.project.name,
      platform: destination ? (toUiPlatform(destination.platform) ?? "TIKTOK") : "TIKTOK",
      reason: "Waiting on a person before anything is queued.",
      waitingSinceHours: Math.max(0, differenceInHours(new Date(), post.createdAt)),
    };
  }

  private toScheduledPost(row: DestinationWithRelations): ScheduledPost {
    return {
      id: row.id,
      contentItemId: row.postId,
      title: row.post.asset.title,
      clientName: row.post.project.name,
      platform: toUiPlatform(row.platform) ?? "TIKTOK",
      scheduledFor: (row.post.scheduledFor ?? row.post.createdAt).toISOString(),
      status: postToContentStatus(row.post),
      thumbnailTone: toneFor(row.id),
    };
  }

  private toScriptDraft(post: PostWithRelations): ScriptDraft {
    const beats = readTreatmentBeats(post.variant.treatment);
    const window = (index: number, fallback: [number, number]): [number, number] => {
      const beat = beats[index];
      return beat ? [beat.startSeconds, beat.endSeconds] : fallback;
    };

    return {
      id: post.variant.id,
      contentItemId: post.id,
      workingTitle: post.asset.title,
      hook: post.variant.hook,
      body: post.variant.caption,
      cta: post.variant.cta,
      hookWindowSec: window(0, [0, 3]),
      bodyWindowSec: window(1, [3, 20]),
      ctaWindowSec: window(beats.length - 1, [20, 25]),
      generatedBy: post.variant.generatedBy === null ? "HUMAN" : "AI",
      updatedAt: post.variant.updatedAt.toISOString(),
    };
  }

  private toGenerationJob(job: RenderJobRow, contentItemId: string): GenerationJob {
    return {
      generationJobId: job.id,
      contentItemId,
      status: renderToGenerationStatus(job),
      progress: job.progress,
      previewUrl: job.outputKey ? `/api/media/${job.outputKey}` : null,
      finalVideoUrl:
        job.status === RenderStatus.SUCCEEDED && job.outputKey
          ? `/api/media/${job.outputKey}`
          : null,
      thumbnailUrl: null,
      qaStatus:
        job.status === RenderStatus.SUCCEEDED
          ? "PASSED"
          : job.errorKind === "OUTPUT_INVALID"
            ? "FAILED"
            : job.status === RenderStatus.FAILED
              ? "FLAGGED"
              : "PENDING",
      failureReason: job.error,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }

  private countQueue(items: ContentItem[]): QueueCounts {
    const of = (status: ContentStatus) => items.filter((item) => item.status === status).length;
    return {
      ideas: 0,
      briefs: of("BRIEF"),
      scripts: of("SCRIPT"),
      assetsReady: of("ASSET_READY"),
      generating: of("GENERATING"),
      needsReview: of("NEEDS_REVIEW"),
      approved: of("APPROVED"),
      scheduled: of("SCHEDULED"),
      published: of("PUBLISHED"),
      failed: of("FAILED"),
    };
  }
}

// ---------------------------------------------------------------------------
// Shared query shapes
// ---------------------------------------------------------------------------

const POST_INCLUDE = {
  project: true,
  variant: true,
  asset: { include: { renderedBy: true } },
  targets: true,
} as const;

const DESTINATION_INCLUDE = {
  post: { include: { project: true, asset: true, variant: true, targets: true } },
} as const;

type PostWithRelations = Awaited<
  ReturnType<typeof prisma.post.findFirstOrThrow<{ include: typeof POST_INCLUDE }>>
>;
type DestinationWithRelations = Awaited<
  ReturnType<typeof prisma.postPlatform.findFirstOrThrow<{ include: typeof DESTINATION_INCLUDE }>>
>;
type RenderJobRow = Awaited<ReturnType<typeof prisma.renderJob.findFirstOrThrow>>;

// ---------------------------------------------------------------------------
// Value mapping
// ---------------------------------------------------------------------------

const PILLAR_TOKENS = ["accent", "violet", "ok", "warn", "info"] as const;

const CAPTION_STYLES = [
  { id: "bold", label: "Bold", description: "Heavy weight, high contrast, centred." },
  { id: "clean", label: "Clean", description: "Light weight, lower third." },
  { id: "none", label: "None", description: "No burned-in captions." },
];

/**
 * The dashboard knows five platforms; this backend implements three. An adapter
 * that invented a mapping for the other two would put content in front of a
 * publisher that does not exist.
 */
function toUiPlatform(platform: DbPlatform | undefined): Platform | null {
  if (platform === "TIKTOK") return "TIKTOK";
  if (platform === "INSTAGRAM") return "INSTAGRAM";
  if (platform === "YOUTUBE") return "YOUTUBE";
  return null;
}

function postToContentStatus(post: {
  status: PostStatus;
  approvalState: ApprovalState;
}): ContentStatus {
  if (post.status === PostStatus.FAILED) return "FAILED";
  if (post.status === PostStatus.PUBLISHED) return "PUBLISHED";
  if (post.status === PostStatus.UPLOADING) return "SCHEDULED";
  if (post.status === PostStatus.SCHEDULED) return "SCHEDULED";
  if (post.approvalState === ApprovalState.PENDING) return "NEEDS_REVIEW";
  if (post.status === PostStatus.APPROVED) return "APPROVED";
  if (post.status === PostStatus.READY) return "ASSET_READY";
  return "SCRIPT";
}

function briefStatusToContentStatus(status: string): ContentStatus {
  if (status === "FULFILLED") return "PUBLISHED";
  if (status === "READY") return "ASSET_READY";
  if (status === "IN_PRODUCTION") return "SCRIPT";
  return "BRIEF";
}

/** The render lifecycle mapped onto the generation lifecycle the UI models. */
function renderToGenerationStatus(job: RenderJobRow): GenerationJob["status"] {
  if (job.status === RenderStatus.SUCCEEDED) return "READY";
  if (job.status === RenderStatus.FAILED || job.status === RenderStatus.CANCELLED) return "FAILED";
  if (job.status === RenderStatus.PENDING) return "QUEUED";

  switch (job.stage) {
    case "VALIDATING":
    case "PREPARING":
      return "PLANNING";
    case "CLIPPING":
      return "GENERATING";
    case "ASSEMBLING":
    case "ENCODING":
      return "RENDERING";
    case "PROBING":
    case "REGISTERING":
      return "QA";
    default:
      return "QUEUED";
  }
}

function toIntegrationStatus(status: AccountStatus): IntegrationProvider["status"] {
  if (status === AccountStatus.CONNECTED) return "CONNECTED";
  if (status === AccountStatus.NEEDS_REAUTH || status === AccountStatus.CHALLENGE) {
    return "NEEDS_REAUTH";
  }
  if (status === AccountStatus.ERROR) return "ERROR";
  return "NOT_CONNECTED";
}

function activityKind(action: string): ActivityEvent["kind"] {
  if (action.includes("publish")) return "PUBLISH";
  if (action.includes("schedul")) return "SCHEDULE";
  if (action.includes("analy") || action.includes("metric")) return "REPORT";
  if (action.includes("recommend")) return "OPTIMISATION";
  if (action.includes("project") || action.includes("account")) return "CLIENT";
  if (action.includes("variant") || action.includes("script")) return "SCRIPT";
  return "IDEA";
}

function cadenceLabel(rationale: unknown): string {
  const value = (rationale as { briefTarget?: number; cadenceSource?: string } | null) ?? null;
  if (!value?.briefTarget) return "Not stated";
  return `${value.briefTarget} planned${value.cadenceSource ? ` — ${value.cadenceSource}` : ""}`;
}

function shareOf(briefs: Array<{ pillarSlug: string | null }>, slug: string): number {
  if (briefs.length === 0) return 0;
  const mine = briefs.filter((brief) => brief.pillarSlug === slug).length;
  return Math.round((mine / briefs.length) * 100);
}

function topRows(
  snapshots: Array<{
    views: number;
    likes: number;
    comments: number;
    shares: number;
    postPlatform: {
      platform: DbPlatform;
      publishedAt: Date | null;
      post: { id: string; asset: { title: string } };
    };
  }>,
): AnalyticsSummary["topContent"] {
  const byDestination = new Map<string, (typeof snapshots)[number]>();
  for (const row of snapshots) {
    const key = row.postPlatform.post.id;
    const existing = byDestination.get(key);
    if (!existing || row.views > existing.views) byDestination.set(key, row);
  }

  return [...byDestination.values()]
    .sort((a, b) => b.views - a.views)
    .slice(0, 8)
    .map((row) => ({
      contentItemId: row.postPlatform.post.id,
      title: row.postPlatform.post.asset.title,
      platform: toUiPlatform(row.postPlatform.platform) ?? "TIKTOK",
      publishedAt: (row.postPlatform.publishedAt ?? new Date()).toISOString(),
      views: row.views,
      engagementRatePct:
        row.views === 0 ? 0 : ((row.likes + row.comments + row.shares) / row.views) * 100,
      completionRatePct: 0,
      pillarId: "general",
    }));
}

function readTreatmentBeats(
  treatment: unknown,
): Array<{ startSeconds: number; endSeconds: number }> {
  const beats = (treatment as { beats?: unknown } | null)?.beats;
  if (!Array.isArray(beats)) return [];
  return beats.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.startSeconds !== "number" || typeof row.endSeconds !== "number") return [];
    return [{ startSeconds: row.startSeconds, endSeconds: row.endSeconds }];
  });
}

/** A stable decorative gradient token, so a card looks the same on every load. */
function toneFor(id: string): string {
  const tones = ["cyan", "violet", "emerald", "amber", "rose", "sky"];
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return tones[hash % tones.length]!;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
