import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Plus, Sparkles } from "lucide-react";
import { prisma } from "@/server/db";
import { loadPostFacts } from "@/server/analytics/aggregate";
import { estimatePerformance } from "@/server/learning/engine";
import { getAdapter, listAdapters } from "@/server/platforms/registry";
import {
  analyzeAssetAction,
  attachAssetToBriefAction,
  createVariantAction,
} from "@/app/actions/posts";
import { openBriefs } from "@/server/content-director";
import { readBeats } from "@/server/services/treatment-service";
import { latestRenderForVariant } from "@/server/rendering";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Badge,
  Card,
  CardHeader,
  Divider,
  EmptyState,
  KeyValue,
  ProjectDot,
  SectionLabel,
} from "@/components/ui/primitives";
import { AssetThumb } from "@/components/content/asset-thumb";
import { Composer, type ComposerAccount } from "@/components/content/composer";
import { VariantCard, type Scorecard } from "@/components/content/variant-card";
import type { RenderView } from "@/components/content/render-panel";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import { buttonClass } from "@/components/ui/button-styles";
import {
  CapabilityBadge,
  PlatformBadge,
  PostStatusBadge,
  platformLabel,
} from "@/components/ui/status";
import { bytes, dateTimeLabel, duration, humanize } from "@/lib/utils";
import { AccountStatus, Confidence, PublishPolicy } from "@/generated/prisma/enums";

export const dynamic = "force-dynamic";

export async function generateMetadata(
  props: PageProps<"/content/[assetId]">,
): Promise<Metadata> {
  const { assetId } = await props.params;
  const asset = await prisma.contentAsset.findUnique({
    where: { id: assetId },
    select: { title: true },
  });
  return { title: asset?.title ?? "Asset" };
}

const POLICY_NOTES: Record<PublishPolicy, string> = {
  MANUAL_APPROVAL:
    "This project requires manual approval, so the post will wait for a person before anything is queued.",
  AUTO_PUBLISH:
    "This project is set to auto publish: the post will be queued immediately for the time you choose.",
  SMART_APPROVAL:
    "Smart approval: the post skips review only if its scorecard averages 8+ and every platform accepted the media without warnings.",
};

export default async function AssetPage(props: PageProps<"/content/[assetId]">) {
  const { assetId } = await props.params;

  const asset = await prisma.contentAsset.findUnique({
    where: { id: assetId },
    include: {
      project: {
        include: {
          accounts: { orderBy: { platform: "asc" } },
          brand: true,
        },
      },
      pillar: true,
      brief: { select: { id: true, workingTitle: true, strategyBasis: true } },
      uploader: { select: { name: true } },
      analyses: { orderBy: { createdAt: "desc" }, take: 1 },
      variants: {
        orderBy: [{ isControl: "desc" }, { createdAt: "asc" }],
        include: { _count: { select: { posts: true } } },
      },
      posts: {
        orderBy: { createdAt: "desc" },
        include: {
          variant: { select: { hook: true } },
          targets: { select: { platform: true, status: true } },
        },
      },
    },
  });

  if (!asset) notFound();

  const analysis = asset.analyses[0] ?? null;
  const facts = await loadPostFacts({ projectId: asset.projectId });
  // The production queue for this project, so an asset can be pointed at the
  // brief it was made for. The link is declared, never inferred.
  const briefs = await openBriefs(asset.projectId);
  // The newest render per variant, so the card can show the cut itself rather
  // than only a status.
  const renders = new Map(
    await Promise.all(
      asset.variants.map(
        async (variant) =>
          [variant.id, await latestRenderForVariant(variant.id)] as const,
      ),
    ),
  );

  // Per-account eligibility, decided by each platform adapter's own constraints.
  const accounts: ComposerAccount[] = asset.project.accounts.map((account) => {
    const verdict = getAdapter(account.platform).validateMedia({
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      durationSeconds: asset.durationSeconds,
      aspectRatio: asset.aspectRatio,
    });
    const errors = verdict.issues.filter((issue) => issue.severity === "error");
    return {
      id: account.id,
      platform: account.platform,
      handle: account.handle,
      connected: account.status === AccountStatus.CONNECTED,
      blockedReason: errors.length > 0 ? errors.map((issue) => issue.message).join(" ") : null,
      warnings: verdict.issues
        .filter((issue) => issue.severity === "warning")
        .map((issue) => `${platformLabel(account.platform)}: ${issue.message}`),
    };
  });

  // Default the composer to the next whole hour, local time.
  const defaultTime = new Date();
  defaultTime.setMinutes(0, 0, 0);
  defaultTime.setHours(defaultTime.getHours() + 1);

  return (
    <>
      <PageHeader
        title={asset.title}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <ProjectDot color={asset.project.accentColor} />
            {asset.project.name}
            <span className="text-ink-muted">·</span>
            {asset.originalFilename}
          </span>
        }
        actions={
          <>
            <Link
              href={`/content?project=${asset.project.slug}`}
              className={buttonClass("ghost", "md")}
            >
              <ArrowLeft />
              Library
            </Link>
            <ActionForm action={analyzeAssetAction}>
              <input type="hidden" name="assetId" value={asset.id} />
              <SubmitButton variant="secondary" pendingLabel="Analysing…">
                <Sparkles />
                Re-run analysis
              </SubmitButton>
            </ActionForm>
          </>
        }
      />

      <PageBody className="space-y-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          {/* --- The file itself ----------------------------------------- */}
          <div className="space-y-4">
            <Card>
              <div className="p-3">
                <AssetThumb
                  kind={asset.kind}
                  storageKey={asset.storageKey}
                  mimeType={asset.mimeType}
                  aspectRatio={asset.aspectRatio}
                  durationSeconds={asset.durationSeconds}
                  hasAudio={asset.hasAudio}
                  accentColor={asset.project.accentColor}
                  className="aspect-[9/16] w-full"
                />
              </div>
              <Divider />
              <dl className="grid grid-cols-2 gap-3 px-4 py-3.5">
                <KeyValue label="Duration">{duration(asset.durationSeconds)}</KeyValue>
                <KeyValue label="Dimensions">
                  {asset.width && asset.height ? `${asset.width}×${asset.height}` : "—"}
                </KeyValue>
                <KeyValue label="Aspect">{asset.aspectRatio ?? "—"}</KeyValue>
                <KeyValue label="Audio">
                  {asset.hasAudio === null ? "Unknown" : asset.hasAudio ? "Yes" : "No"}
                </KeyValue>
                <KeyValue label="Size">{bytes(asset.sizeBytes)}</KeyValue>
                <KeyValue label="Type">{asset.mimeType}</KeyValue>
                <KeyValue label="Pillar">{asset.pillar?.name ?? "Unassigned"}</KeyValue>
                <KeyValue label="Status">{humanize(asset.status)}</KeyValue>
                <KeyValue label="Uploaded" className="col-span-2">
                  {dateTimeLabel(asset.createdAt)}
                  {asset.uploader?.name ? ` by ${asset.uploader.name}` : ""}
                </KeyValue>
                <KeyValue label="Fingerprint" className="col-span-2">
                  <code className="break-all text-[10.5px] text-ink-muted">
                    {asset.checksum}
                  </code>
                </KeyValue>
              </dl>
            </Card>

            <Card>
              <CardHeader
                title="Analysis"
                subtitle={
                  analysis
                    ? `${analysis.model ?? `${analysis.provider} — rules, no language model`} · ${analysis.promptVersion ?? "unversioned prompt"}`
                    : "Not analysed yet."
                }
                action={
                  analysis ? (
                    <Badge tone={confidenceTone(analysis.confidence)}>
                      {analysis.confidence} confidence
                    </Badge>
                  ) : null
                }
              />
              {analysis ? (
                <div className="space-y-3 px-4 py-3.5">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge tone="accent">{humanize(analysis.format)}</Badge>
                    {analysis.topic ? <Badge tone="neutral">{analysis.topic}</Badge> : null}
                  </div>
                  {analysis.visualSummary ? (
                    <KeyValue label="Read from the file">{analysis.visualSummary}</KeyValue>
                  ) : null}
                  {analysis.likelyAudience ? (
                    <KeyValue label="Audience">{analysis.likelyAudience}</KeyValue>
                  ) : null}
                  <KeyValue label="Transcript">
                    {analysis.transcript ?? (
                      <span className="text-ink-muted">
                        None — nothing here has heard the audio.
                      </span>
                    )}
                  </KeyValue>
                  {analysis.basis.length > 0 ? (
                    <div>
                      <SectionLabel>What this rests on</SectionLabel>
                      <ul className="mt-1 space-y-1">
                        {analysis.basis.map((item, index) => (
                          <li
                            key={index}
                            className="text-[10.5px] leading-relaxed text-ink-secondary"
                          >
                            · {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {analysis.unknowns.length > 0 ? (
                    <div>
                      <SectionLabel>What it could not determine</SectionLabel>
                      <ul className="mt-1 space-y-1">
                        {analysis.unknowns.map((item, index) => (
                          <li
                            key={index}
                            className="text-[10.5px] leading-relaxed text-ink-muted"
                          >
                            · {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {limitationsOf(analysis.raw).length > 0 ? (
                    <div>
                      <SectionLabel>Known limits</SectionLabel>
                      <ul className="mt-1 space-y-1">
                        {limitationsOf(analysis.raw).map((limitation, index) => (
                          <li
                            key={index}
                            className="text-[10.5px] leading-relaxed text-ink-muted"
                          >
                            · {limitation}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : (
                <EmptyState
                  icon={<Sparkles />}
                  title="No analysis on record"
                  body="Run the analysis to read the container facts and draft copy for this asset."
                />
              )}
            </Card>

            <Card>
              <CardHeader
                title="Brief"
                subtitle="Which planned piece this asset is. Publishing it then fulfils that brief, which is what makes a post traceable back to the strategy."
              />
              <div className="px-4 py-3.5">
                {asset.brief ? (
                  <div className="space-y-2">
                    <p className="text-[12.5px] text-ink">{asset.brief.workingTitle}</p>
                    <p className="text-[11.5px] leading-relaxed text-ink-muted">
                      Serves: {asset.brief.strategyBasis}
                    </p>
                    <ActionForm action={attachAssetToBriefAction}>
                      <input type="hidden" name="assetId" value={asset.id} />
                      <input type="hidden" name="briefId" value="" />
                      <SubmitButton variant="ghost" size="sm" pendingLabel="Unlinking…">
                        Unlink
                      </SubmitButton>
                    </ActionForm>
                  </div>
                ) : briefs.length > 0 ? (
                  <ActionForm
                    action={attachAssetToBriefAction}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <input type="hidden" name="assetId" value={asset.id} />
                    <select
                      name="briefId"
                      aria-label="Brief this asset fulfils"
                      className="min-w-0 flex-1 rounded-md border border-hairline bg-surface-raised px-2 py-1.5 text-[12px] text-ink"
                    >
                      {briefs.map((brief) => (
                        <option key={brief.id} value={brief.id}>
                          #{brief.sequence} {brief.workingTitle}
                        </option>
                      ))}
                    </select>
                    <SubmitButton variant="ghost" size="sm" pendingLabel="Linking…">
                      Link
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <p className="text-[11.5px] leading-relaxed text-ink-muted">
                    No open briefs for this project. Plan a window on the Plan screen, or
                    leave this asset unlinked — an unlinked asset publishes fine, it just
                    cannot be traced back to a strategy decision.
                  </p>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Platform fit"
                subtitle="Checked against each adapter's declared constraints, before anything is queued."
              />
              <ul className="divide-y divide-hairline">
                {listAdapters().map((adapter) => {
                  const verdict = adapter.validateMedia({
                    mimeType: asset.mimeType,
                    sizeBytes: asset.sizeBytes,
                    durationSeconds: asset.durationSeconds,
                    aspectRatio: asset.aspectRatio,
                  });
                  return (
                    <li key={adapter.platform} className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <PlatformBadge platform={adapter.platform} />
                        <CapabilityBadge mode={adapter.capabilities.publish} />
                        <Badge tone={verdict.ok ? "good" : "critical"}>
                          {verdict.ok ? "Accepted" : "Rejected"}
                        </Badge>
                      </div>
                      {verdict.issues.length > 0 ? (
                        <ul className="mt-1.5 space-y-1">
                          {verdict.issues.map((issue, index) => (
                            <li
                              key={index}
                              className={`text-[10.5px] leading-relaxed ${
                                issue.severity === "error"
                                  ? "text-[#ec7d7d]"
                                  : "text-[#f6c455]"
                              }`}
                            >
                              {issue.message}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>

          {/* --- Copy and scheduling ------------------------------------- */}
          <div className="space-y-4">
            <Card>
              <CardHeader
                title="Schedule this asset"
                subtitle="Pick the copy, the destinations and the time."
              />
              <Composer
                projectId={asset.projectId}
                assetId={asset.id}
                variants={asset.variants.map((variant) => ({
                  id: variant.id,
                  label: variant.label,
                  hook: variant.hook,
                  isControl: variant.isControl,
                }))}
                accounts={accounts}
                policyNote={POLICY_NOTES[asset.project.publishPolicy]}
                defaultScheduledFor={toLocalInputValue(defaultTime)}
              />
            </Card>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold tracking-tight text-ink">
                  Copy variants ({asset.variants.length})
                </h2>
                <span className="text-[10.5px] text-ink-muted">
                  Variants are the unit of experimentation — each is tracked separately.
                </span>
              </div>
              <div className="space-y-2.5">
                {asset.variants.map((variant) => (
                  <VariantCard
                    key={variant.id}
                    variantId={variant.id}
                    assetId={asset.id}
                    label={variant.label}
                    hook={variant.hook}
                    caption={variant.caption}
                    hashtags={variant.hashtags}
                    cta={variant.cta}
                    isControl={variant.isControl}
                    scorecard={parseScorecard(variant.scorecard)}
                    estimate={
                      facts.length > 0
                        ? estimatePerformance({
                            facts,
                            hook: variant.hook,
                            format: analysis?.format ?? null,
                            durationSeconds: asset.durationSeconds,
                            hour: defaultTime.getHours(),
                            cta: variant.cta,
                          })
                        : null
                    }
                    usedInPosts={variant._count.posts}
                    render={renderViewOf(renders.get(variant.id))}
                    treatment={
                      variant.treatment
                        ? {
                            beats: readBeats(variant.treatment),
                            narrativeStructure: variant.narrativeStructure,
                            ctaPlacement: variant.ctaPlacement,
                            deliversKeyMessage: variant.deliversKeyMessage,
                            keyMessageNote: variant.keyMessageNote,
                            generatedBy: variant.generatedBy,
                            model: variant.model,
                            promptVersion: variant.promptVersion,
                          }
                        : null
                    }
                  />
                ))}
              </div>
            </section>

            <Card>
              <CardHeader
                title="Write another variant"
                subtitle="Same asset, different angle. This is how a hook test gets built."
              />
              <ActionForm
                action={createVariantAction}
                className="space-y-2.5 px-4 py-3.5"
                resetOnSuccess
              >
                <input type="hidden" name="assetId" value={asset.id} />
                <div className="grid gap-2.5 sm:grid-cols-2">
                  <Field label="Label" name="label" placeholder="Price anchor" required />
                  <Field
                    label="Call to action"
                    name="cta"
                    placeholder={asset.project.brand?.primaryCta ?? "Link in bio"}
                  />
                </div>
                <Field
                  label="Hook"
                  name="hook"
                  placeholder="Would you pay $29 instead of $2,000?"
                  required
                />
                <div>
                  <SectionLabel>Caption</SectionLabel>
                  <textarea
                    name="caption"
                    required
                    rows={3}
                    className="mt-1 w-full resize-y rounded-md border border-hairline-strong bg-surface-raised px-2 py-1.5 text-[12.5px] leading-relaxed text-ink"
                  />
                </div>
                <Field
                  label="Hashtags"
                  name="hashtags"
                  placeholder="#creatoreconomy #smma"
                />
                <SubmitButton size="sm" pendingLabel="Adding…">
                  <Plus />
                  Add variant
                </SubmitButton>
              </ActionForm>
            </Card>

            {asset.posts.length > 0 ? (
              <Card>
                <CardHeader
                  title="Publish history"
                  subtitle={`${asset.posts.length} post${asset.posts.length === 1 ? "" : "s"} built from this asset.`}
                />
                <ul className="divide-y divide-hairline">
                  {asset.posts.map((post) => (
                    <li
                      key={post.id}
                      className="flex flex-wrap items-center gap-2 px-4 py-2.5"
                    >
                      <PostStatusBadge status={post.status} />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                        {post.variant.hook}
                      </span>
                      <span className="text-[10.5px] text-ink-muted">
                        {post.targets.map((target) => platformLabel(target.platform)).join(", ")}
                      </span>
                      <span className="text-[10.5px] tabular text-ink-muted">
                        {post.scheduledFor ? dateTimeLabel(post.scheduledFor) : "no time"}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        </div>
      </PageBody>
    </>
  );
}

function Field({
  label,
  name,
  placeholder,
  required,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <input
        name={name}
        placeholder={placeholder}
        required={required}
        className="mt-1 w-full rounded-md border border-hairline-strong bg-surface-raised px-2 py-1.5 text-[12.5px] text-ink placeholder:text-ink-muted"
      />
    </div>
  );
}

function parseScorecard(value: unknown): Scorecard | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const numeric = (key: string) =>
    typeof record[key] === "number" ? (record[key] as number) : 0;
  return {
    hook: numeric("hook"),
    clarity: numeric("clarity"),
    curiosity: numeric("curiosity"),
    cta: numeric("cta"),
    trendRelevance: numeric("trendRelevance"),
    notes: Array.isArray(record.notes) ? (record.notes as string[]) : [],
  };
}

/** Narrows a render job row to what the card is allowed to show. */
function renderViewOf(
  job: Awaited<ReturnType<typeof latestRenderForVariant>> | undefined,
): RenderView | null {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    attempts: job.attempts,
    durationMs: job.durationMs,
    errorKind: job.errorKind,
    error: job.error,
    failureStage: job.failureStage,
    logExcerpt: job.logExcerpt,
    provider: job.provider,
    output: job.outputAsset
      ? {
          storageKey: job.outputAsset.storageKey,
          durationSeconds: job.outputAsset.durationSeconds,
          width: job.outputAsset.width,
          height: job.outputAsset.height,
          sizeBytes: job.outputAsset.sizeBytes,
        }
      : null,
  };
}

function confidenceTone(confidence: Confidence): "good" | "warning" | "neutral" {
  if (confidence === Confidence.HIGH) return "good";
  if (confidence === Confidence.MEDIUM) return "neutral";
  return "warning";
}

function limitationsOf(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const limitations = (raw as Record<string, unknown>).limitations;
  return Array.isArray(limitations) ? (limitations as string[]) : [];
}

/** `datetime-local` needs "YYYY-MM-DDTHH:mm" in local time, not an ISO string. */
function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
