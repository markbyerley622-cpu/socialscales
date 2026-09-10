"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  CalendarPlus,
  CheckCheck,
  Film,
  Layers,
  Loader2,
  Plus,
  Save,
  Sparkles,
  Upload,
  Wand2,
} from "lucide-react";

import {
  approveContentAction,
  generateContentAction,
  generateIdeasAction,
  rewriteScriptAction,
  scheduleContentAction,
  updateScriptAction,
} from "@/app/actions";
import { GenerationBadge, PlatformChip, StatusBadge, Thumb } from "@/components/ui/data-display";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  Progress,
  Textarea,
} from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/tabs";
import type { RewriteDirective } from "@/lib/social-scales/adapter";
import type { ContentIdea, MediaAsset, StudioView } from "@/lib/social-scales/contracts";
import { cn, formatDuration } from "@/lib/utils";

const IDEA_TABS = [
  { value: "FOR_YOU", label: "For you" },
  { value: "TRENDING", label: "Trending" },
  { value: "CLIENT_GOALS", label: "Client goals" },
  { value: "SAVED", label: "Saved" },
] as const;

const ASSET_TABS = [
  { value: "ALL", label: "All" },
  { value: "VIDEO", label: "Videos" },
  { value: "IMAGE", label: "Images" },
  { value: "AUDIO", label: "Audio" },
  { value: "GRAPHIC", label: "Graphics" },
  { value: "BRAND_KIT", label: "Brand kit" },
] as const;

const REWRITES: Array<{ directive: RewriteDirective; label: string }> = [
  { directive: "BRAND_VOICE", label: "Rewrite in brand voice" },
  { directive: "SHORTER", label: "Shorter" },
  { directive: "STRONGER_HOOK", label: "Stronger hook" },
  { directive: "MORE_DIRECT", label: "More direct" },
];

const CAPTION_PREVIEW_STYLE: Record<string, string> = {
  cs_modern: "text-[15px] font-extrabold uppercase tracking-tight text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]",
  cs_minimal: "text-[12px] font-medium tracking-wide text-white/90",
  cs_neon: "text-[15px] font-bold text-accent drop-shadow-[0_0_10px_rgba(34,211,238,0.75)]",
  cs_cinematic: "text-[13px] font-semibold tracking-[0.08em] text-white/95",
  cs_subtle: "text-[12px] font-normal text-white/80",
  cs_brand: "text-[14px] font-semibold text-white",
};

function toLocalInputValue(iso: string | null): string {
  const date = iso ? new Date(iso) : new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function StudioWorkspace({ view }: { view: StudioView }) {
  const router = useRouter();

  const [ideaTab, setIdeaTab] = React.useState<(typeof IDEA_TABS)[number]["value"]>("FOR_YOU");
  const [assetTab, setAssetTab] = React.useState<(typeof ASSET_TABS)[number]["value"]>("ALL");
  const [ideas, setIdeas] = React.useState<ContentIdea[]>(view.ideas);
  const [selectedIdeaId, setSelectedIdeaId] = React.useState<string>(view.ideas[0]?.id ?? "");

  const [script, setScript] = React.useState(view.script);
  const [variantId, setVariantId] = React.useState(view.variants.find((v) => v.selected)?.id ?? view.variants[0]?.id);
  const [captionStyleId, setCaptionStyleId] = React.useState(view.activeCaptionStyleId);
  const [assets, setAssets] = React.useState<MediaAsset[]>(view.assets);
  const [item, setItem] = React.useState(view.contentItem);

  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [scheduleAt, setScheduleAt] = React.useState(() => toLocalInputValue(view.contentItem.plannedPublishAt));
  const [dirty, setDirty] = React.useState(false);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  const saveScript = () =>
    run("save", async () => {
      const result = await updateScriptAction(item.id, {
        workingTitle: script.workingTitle,
        hook: script.hook,
        body: script.body,
        cta: script.cta,
      });
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setScript(result.data);
      setDirty(false);
      setNotice({ kind: "ok", text: "Draft saved." });
    });

  const rewrite = (directive: RewriteDirective) =>
    run(directive, async () => {
      const result = await rewriteScriptAction(item.id, directive);
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setScript(result.data);
      setDirty(false);
      setNotice({ kind: "ok", text: "Script rewritten." });
    });

  const moreIdeas = () =>
    run("ideas", async () => {
      const result = await generateIdeasAction(item.clientId, 5);
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setIdeas((current) => [...result.data, ...current]);
      setIdeaTab("FOR_YOU");
    });

  const generateVideo = () =>
    run("generate", async () => {
      const result = await generateContentAction(item.id);
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setItem((current) => ({ ...current, status: "GENERATING", generation: result.data }));
      setNotice({ kind: "ok", text: "Generation job queued." });
      router.refresh();
    });

  const approve = () =>
    run("approve", async () => {
      const result = await approveContentAction(item.id);
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setItem(result.data);
      setNotice({ kind: "ok", text: "Approved. It can now be scheduled." });
      router.refresh();
    });

  const schedule = () =>
    run("schedule", async () => {
      const result = await scheduleContentAction(item.id, new Date(scheduleAt).toISOString());
      if (!result.ok) {
        setNotice({ kind: "error", text: result.error });
        return;
      }
      setItem(result.data);
      setNotice({ kind: "ok", text: "Scheduled." });
      router.refresh();
    });

  const toggleAsset = (assetId: string) =>
    setAssets((current) => current.map((a) => (a.id === assetId ? { ...a, selected: !a.selected } : a)));

  const visibleIdeas = ideas.filter((idea) => idea.source === ideaTab);
  const visibleAssets = assets.filter((asset) => assetTab === "ALL" || asset.kind === assetTab);
  const selectedAssets = assets.filter((a) => a.selected);
  const captionClass = CAPTION_PREVIEW_STYLE[captionStyleId] ?? CAPTION_PREVIEW_STYLE.cs_modern;

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
      {/* ------------------------------ LEFT ------------------------------ */}
      <div className="flex flex-col gap-5 xl:col-span-3">
        <Panel>
          <PanelHeader eyebrow="Content ideas" title={`${visibleIdeas.length} in this list`} />
          <PanelBody className="pb-3">
            <Tabs
              ariaLabel="Idea source"
              items={IDEA_TABS.map((t) => ({
                ...t,
                count: ideas.filter((idea) => idea.source === t.value).length,
              }))}
              value={ideaTab}
              onChange={setIdeaTab}
              size="sm"
              className="w-full"
            />
          </PanelBody>
          <PanelBody>
            {visibleIdeas.length === 0 ? (
              <EmptyState
                title="No ideas in this list"
                description="Generate more against the active plan, or switch list."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {visibleIdeas.map((idea) => {
                  const active = idea.id === selectedIdeaId;
                  return (
                    <li key={idea.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedIdeaId(idea.id)}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-[var(--radius-card)] border p-2.5 text-left transition-colors",
                          active
                            ? "border-accent/40 bg-accent/8"
                            : "border-hairline bg-surface-2/50 hover:border-accent/25",
                        )}
                      >
                        <Thumb tone={idea.thumbnailTone} className="size-12 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-[12.5px] leading-snug font-medium text-ink">
                            {idea.title}
                          </span>
                          <span
                            className={cn(
                              "mt-1 block text-[11px]",
                              idea.potential === "HIGH" ? "text-accent" : "text-ink-faint",
                            )}
                          >
                            {idea.potential === "HIGH"
                              ? "High potential"
                              : idea.potential === "MEDIUM"
                                ? "Worth testing"
                                : "Exploratory"}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <Button variant="secondary" className="mt-3 w-full" onClick={moreIdeas} disabled={busy !== null}>
              {busy === "ideas" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              Generate 5 more ideas
            </Button>
          </PanelBody>
        </Panel>

        {view.brief ? (
          <Panel>
            <PanelHeader eyebrow="Brief" title="Why this piece exists" />
            <PanelBody>
              <dl className="flex flex-col gap-3">
                {[
                  ["Problem", view.brief.problem],
                  ["Transformation", view.brief.transformation],
                  ["Proof", view.brief.proofPoint],
                  ["Call to action", view.brief.callToAction],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="ss-eyebrow">{label}</dt>
                    <dd className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-3 border-t border-hairline pt-3 text-[12px] text-ink-faint">
                Target length {view.brief.targetDurationSec}s
              </p>
            </PanelBody>
          </Panel>
        ) : null}

        <Panel>
          <PanelHeader eyebrow="Selected idea" title="Angle in play" />
          <PanelBody>
            {(() => {
              const idea = ideas.find((i) => i.id === selectedIdeaId);
              if (!idea) {
                return <EmptyState title="No idea selected" description="Pick an idea from the left column." />;
              }
              return (
                <>
                  <p className="text-[13.5px] font-medium text-ink">{idea.title}</p>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">{idea.rationale}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <PlatformChip platform={idea.platform} showLabel />
                    <Badge className="border-hairline bg-white/6 text-ink-muted">
                      {idea.source.replace("_", " ").toLowerCase()}
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      setScript((s) => ({ ...s, workingTitle: idea.title }));
                      setDirty(true);
                    }}
                  >
                    <Plus className="size-3.5" />
                    Use as working title
                  </Button>
                </>
              );
            })()}
          </PanelBody>
        </Panel>
      </div>

      {/* ----------------------------- CENTER ----------------------------- */}
      <div className="flex flex-col gap-5 xl:col-span-5">
        <Panel>
          <PanelHeader
            eyebrow="Script draft"
            title={item.title}
            action={
              <Badge className="border-accent/25 bg-accent/10 text-accent" dot="bg-accent">
                {script.generatedBy === "AI" ? "AI generated" : script.generatedBy === "AI_EDITED" ? "AI + edited" : "Written by you"}
              </Badge>
            }
          />
          <PanelBody className="flex flex-col gap-4">
            <label className="block">
              <span className="mb-1.5 flex items-baseline justify-between">
                <span className="text-[13px] font-medium text-ink">Working title</span>
                <span className="text-[11px] text-ink-faint">{script.workingTitle.length}/100</span>
              </span>
              <Input
                value={script.workingTitle}
                maxLength={100}
                onChange={(e) => {
                  setScript((s) => ({ ...s, workingTitle: e.target.value }));
                  setDirty(true);
                }}
              />
            </label>

            {(
              [
                ["hook", "Hook", script.hookWindowSec, 150],
                ["body", "Body", script.bodyWindowSec, 500],
                ["cta", "CTA", script.ctaWindowSec, 150],
              ] as const
            ).map(([key, label, window, max]) => (
              <div key={key} className="rounded-[var(--radius-card)] border border-hairline bg-surface-2/50 p-3">
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="text-[12px] font-semibold tracking-wide text-ink">
                    {label}
                    <span className="ml-2 font-normal text-ink-faint">
                      ({window[0]}–{window[1]}s)
                    </span>
                  </span>
                  <span className="text-[11px] text-ink-faint tabular-nums">
                    {script[key].length}/{max}
                  </span>
                </div>
                <Textarea
                  rows={key === "body" ? 6 : 3}
                  maxLength={max}
                  value={script[key]}
                  aria-label={`${label} text`}
                  onChange={(e) => {
                    setScript((s) => ({ ...s, [key]: e.target.value }));
                    setDirty(true);
                  }}
                />
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-2">
              {REWRITES.map((r) => (
                <Button
                  key={r.directive}
                  size="sm"
                  variant={r.directive === "BRAND_VOICE" ? "primary" : "secondary"}
                  onClick={() => rewrite(r.directive)}
                  disabled={busy !== null}
                >
                  {busy === r.directive ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                  {r.label}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={saveScript} disabled={busy !== null || !dirty}>
                {busy === "save" ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                {dirty ? "Save draft" : "Saved"}
              </Button>
            </div>

            {notice ? (
              <p
                role="status"
                className={cn("text-[12.5px]", notice.kind === "ok" ? "text-ok" : "text-danger")}
              >
                {notice.text}
              </p>
            ) : null}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader eyebrow="Post variants" title="Angles to test" description="Pick the angle this cut should lead with." />
          <PanelBody>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {view.variants.map((variant, index) => {
                const active = variant.id === variantId;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    onClick={() => setVariantId(variant.id)}
                    aria-pressed={active}
                    className={cn(
                      "flex items-start gap-2.5 rounded-[var(--radius-card)] border p-3 text-left transition-colors",
                      active ? "border-accent/40 bg-accent/8" : "border-hairline bg-surface-2/50 hover:border-accent/25",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                        active ? "border-accent/45 bg-accent/12 text-accent" : "border-hairline-strong text-ink-faint",
                      )}
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-ink">{variant.label}</span>
                      <span className="block text-[11.5px] leading-snug text-ink-muted">{variant.angle}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            eyebrow="Asset library"
            title={`${selectedAssets.length} selected`}
            description="Selected assets are what the render pipeline will cut from."
          />
          <PanelBody className="pb-3">
            <Tabs
              ariaLabel="Filter assets by kind"
              items={ASSET_TABS.map((t) => ({ ...t }))}
              value={assetTab}
              onChange={setAssetTab}
              size="sm"
              className="w-full"
            />
          </PanelBody>
          <PanelBody>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              <button
                type="button"
                disabled
                title="Uploading media requires the backend asset store. Not available in the standalone frontend."
                className="flex aspect-square cursor-not-allowed flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-hairline-strong text-ink-faint"
              >
                <Upload className="size-4" />
                <span className="text-[11px]">Upload</span>
                <span className="text-[9.5px]">Backend only</span>
              </button>

              {visibleAssets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => toggleAsset(asset.id)}
                  aria-pressed={asset.selected}
                  className="group text-left"
                >
                  <Thumb
                    tone={asset.thumbnailTone}
                    duration={asset.durationSec ? formatDuration(asset.durationSec) : undefined}
                    className={cn(
                      "aspect-square w-full transition-shadow",
                      asset.selected && "ring-2 ring-accent ring-offset-2 ring-offset-surface",
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-1.5 left-1.5 z-10 inline-flex size-4 items-center justify-center rounded-full border text-[9px]",
                        asset.selected ? "border-accent bg-accent text-[#04121a]" : "border-white/45 bg-black/35",
                      )}
                    >
                      {asset.selected ? "✓" : ""}
                    </span>
                  </Thumb>
                  <span className="mt-1 block truncate text-[10.5px] text-ink-faint">{asset.fileName}</span>
                </button>
              ))}
            </div>
          </PanelBody>
        </Panel>
      </div>

      {/* ------------------------------ RIGHT ----------------------------- */}
      <div className="flex flex-col gap-5 xl:col-span-4">
        <Panel className="xl:sticky xl:top-20">
          <PanelHeader
            eyebrow="Post preview"
            title="9:16 vertical"
            action={<PlatformChip platform={item.platform} showLabel />}
          />
          <PanelBody>
            <div className="flex flex-col gap-4 sm:flex-row xl:flex-col 2xl:flex-row">
              {/* Phone preview */}
              <div className="mx-auto w-full max-w-[230px] shrink-0">
                <div
                  className={cn(
                    "relative aspect-[9/16] overflow-hidden rounded-xl border border-hairline-strong",
                    "bg-[linear-gradient(160deg,#12303c,#0b1b26_55%,#070f16)]",
                  )}
                >
                  <div className="absolute inset-0 bg-[radial-gradient(120%_70%_at_25%_10%,rgba(34,211,238,0.16),transparent_60%)]" />

                  {/* Caption block */}
                  <div className="absolute inset-x-3 top-1/2 -translate-y-1/2">
                    <p className={cn("leading-snug", captionClass)}>{script.hook}</p>
                  </div>

                  {/* Bottom meta */}
                  <div className="absolute inset-x-0 bottom-0 bg-[linear-gradient(0deg,rgba(0,0,0,0.82),transparent)] p-3">
                    <p className="text-[11px] font-semibold text-white">@socialscales</p>
                    <p className="mt-1 line-clamp-2 text-[10.5px] leading-snug text-white/80">{script.cta}</p>
                    <p className="mt-1.5 text-[9.5px] text-white/55">Original audio · Social Scales</p>
                  </div>
                </div>

                <p className="mt-2 text-center text-[10.5px] leading-snug text-ink-faint">
                  Layout preview only. The rendered frame comes from the backend generation pipeline.
                </p>
              </div>

              {/* Caption styles */}
              <div className="min-w-0 flex-1">
                <p className="ss-eyebrow">Caption style</p>
                <div className="mt-2 flex flex-col gap-1.5">
                  {view.captionStyles.map((style) => {
                    const active = style.id === captionStyleId;
                    return (
                      <button
                        key={style.id}
                        type="button"
                        onClick={() => setCaptionStyleId(style.id)}
                        aria-pressed={active}
                        className={cn(
                          "rounded-[var(--radius-control)] border px-3 py-2 text-left transition-colors",
                          active ? "border-accent/40 bg-accent/8" : "border-hairline bg-surface-2/50 hover:border-accent/25",
                        )}
                      >
                        <span className={cn("block text-[12.5px]", active ? "font-medium text-accent" : "text-ink")}>
                          {style.label}
                        </span>
                        <span className="block text-[11px] leading-snug text-ink-faint">{style.description}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </PanelBody>
        </Panel>

        {/* Generation + publish */}
        <Panel>
          <PanelHeader
            eyebrow="Generation"
            title="Render and QA"
            action={item.generation ? <GenerationBadge status={item.generation.status} /> : <StatusBadge status={item.status} />}
          />
          <PanelBody>
            {item.generation ? (
              <>
                <Progress
                  value={item.generation.progress}
                  barClassName={cn(item.generation.status === "FAILED" && "bg-danger")}
                />
                <div className="mt-2.5 flex flex-col gap-1 text-[11.5px] text-ink-muted">
                  <span>Job {item.generation.generationJobId}</span>
                  <span>QA: {item.generation.qaStatus.toLowerCase()}</span>
                  {item.generation.failureReason ? (
                    <span className="text-danger">{item.generation.failureReason}</span>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="text-[12.5px] text-ink-muted">
                No render has been requested for this piece yet.
              </p>
            )}

            <Button
              variant="secondary"
              className="mt-3 w-full"
              onClick={generateVideo}
              disabled={busy !== null || selectedAssets.length === 0}
              title={selectedAssets.length === 0 ? "Select at least one asset first." : undefined}
            >
              {busy === "generate" ? <Loader2 className="size-4 animate-spin" /> : <Film className="size-4" />}
              Generate video
            </Button>
            {selectedAssets.length === 0 ? (
              <p className="mt-1.5 text-[11px] text-ink-faint">Select at least one asset to enable generation.</p>
            ) : null}

            <p className="mt-3 border-t border-hairline pt-3 text-[11px] leading-snug text-ink-faint">
              Rendering is performed by the backend generation service behind the <code>GenerationJob</code> contract.
              The standalone build tracks job state but produces no video file.
            </p>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader eyebrow="Publish and next steps" title="Approve, schedule, ship" />
          <PanelBody className="flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-hairline bg-surface-2/50 px-3.5 py-2.5">
              <span className="text-[12.5px] text-ink-muted">Current status</span>
              <StatusBadge status={item.status} />
            </div>

            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-ink">Publish slot</span>
              <Input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="[color-scheme:dark]"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <Button variant="secondary" onClick={saveScript} disabled={busy !== null}>
                {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save draft
              </Button>
              <Button variant="secondary" onClick={approve} disabled={busy !== null || item.status === "APPROVED"}>
                {busy === "approve" ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
                Approve
              </Button>
            </div>

            <Button variant="primary" onClick={schedule} disabled={busy !== null}>
              {busy === "schedule" ? <Loader2 className="size-4 animate-spin" /> : <CalendarPlus className="size-4" />}
              Schedule post
            </Button>

            <button
              type="button"
              disabled
              title="Immediate publishing requires a connected platform account. Connect one in Integrations."
              className="inline-flex h-9 cursor-not-allowed items-center justify-center gap-2 rounded-[var(--radius-control)] border border-hairline bg-surface-3/40 px-4 text-[13px] text-ink-faint"
            >
              <Layers className="size-4" />
              Post now — no platform connected
            </button>
          </PanelBody>
        </Panel>

      </div>
    </div>
  );
}
