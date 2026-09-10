"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  Loader2,
  Megaphone,
  Mic2,
  Rocket,
  Share2,
  Target,
  Users,
} from "lucide-react";

import { completeOnboardingAction, saveOnboardingDraftAction } from "@/app/actions";
import {
  Badge,
  Button,
  Field,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  Progress,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { PLATFORM_META } from "@/lib/display";
import { PLATFORMS, type BrandProfile, type OnboardingState, type Platform } from "@/lib/social-scales/contracts";
import { usePersistentObject } from "@/lib/use-persistent-object";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "social-scales.onboarding-draft.v1";

const STEPS = [
  { key: "BUSINESS", label: "Business", blurb: "Tell us about your business", icon: Building2 },
  { key: "GOALS", label: "Goals", blurb: "What do you want to achieve?", icon: Target },
  { key: "AUDIENCE", label: "Audience", blurb: "Who are you creating for?", icon: Users },
  { key: "BRAND_VOICE", label: "Brand Voice", blurb: "How should your content sound?", icon: Mic2 },
  { key: "PLATFORMS", label: "Platforms", blurb: "Where do you want to post?", icon: Share2 },
  { key: "FIRST_STRATEGY", label: "First Strategy", blurb: "Let the system build your plan", icon: Rocket },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

type Draft = Partial<BrandProfile>;

const NICHES = [
  "AI Tools & Technology",
  "Fitness & Wellness",
  "Business Coaching",
  "E-commerce",
  "Real Estate",
  "SaaS",
  "Professional Services",
  "Creator / Personal Brand",
];

const OBJECTIVES = [
  "Generate leads and customers",
  "Grow audience and awareness",
  "Build authority in the niche",
  "Drive product sales",
  "Recruit and employer branding",
];

const FREQUENCIES = ["1-2 times per week", "3-5 times per week", "Daily", "Multiple times per day"];

const TONES = ["Direct", "Practical", "Confident", "Warm", "Playful", "Analytical", "Premium", "Contrarian"];

const CONTENT_GOALS = [
  "Grow audience",
  "Build authority",
  "Drive booked calls",
  "Sell products",
  "Educate the market",
  "Recruit talent",
];

const ASSET_OPTIONS: Array<{ value: BrandProfile["assetAvailability"]; label: string; detail: string }> = [
  { value: "NONE", label: "No footage yet", detail: "The system will lean on generated visuals and text formats." },
  { value: "SOME", label: "Some raw clips", detail: "Enough to cut short form with occasional gaps." },
  { value: "RICH_LIBRARY", label: "Rich library", detail: "Plenty of footage, screen recordings and brand assets." },
];

const APPROVAL_OPTIONS: Array<{ value: BrandProfile["approvalPreference"]; label: string; detail: string }> = [
  { value: "REVIEW_EVERYTHING", label: "Review everything", detail: "Nothing publishes without your approval." },
  { value: "REVIEW_FIRST_WEEK", label: "Review the first week", detail: "Then auto-publish once you trust the output." },
  { value: "AUTO_PUBLISH", label: "Auto-publish", detail: "Publish on schedule; you can still pull anything back." },
];

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function TagPicker({
  options,
  selected,
  onToggle,
}: {
  options: readonly string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const active = selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(option)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-[12.5px] transition-colors",
              active
                ? "border-accent/45 bg-accent/12 text-accent"
                : "border-hairline-strong bg-surface-3/50 text-ink-muted hover:border-accent/30 hover:text-ink",
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

export function OnboardingWizard({ initialState }: { initialState: OnboardingState }) {
  const router = useRouter();
  const [stepIndex, setStepIndex] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  // An in-progress draft survives a refresh; the server draft is the baseline.
  const { value: draft, update: setDraft, clear: clearDraft } = usePersistentObject<Draft>(
    STORAGE_KEY,
    initialState.draft ?? {},
  );

  const step = STEPS[stepIndex];
  const set = <K extends keyof BrandProfile>(key: K, value: BrandProfile[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const toggleIn = (key: "toneOfVoice" | "contentGoals", value: string) =>
    setDraft((current) => {
      const list = (current[key] as string[] | undefined) ?? [];
      return { ...current, [key]: list.includes(value) ? list.filter((v) => v !== value) : [...list, value] };
    });

  const togglePlatform = (platform: Platform) =>
    setDraft((current) => {
      const list = current.platforms ?? [];
      return {
        ...current,
        platforms: list.includes(platform) ? list.filter((p) => p !== platform) : [...list, platform],
      };
    });

  const stepComplete = (index: number): boolean => {
    switch (STEPS[index].key as StepKey) {
      case "BUSINESS":
        return Boolean(draft.businessName && draft.niche && draft.offer);
      case "GOALS":
        return Boolean(draft.businessObjective && draft.primaryCta);
      case "AUDIENCE":
        return Boolean(draft.idealCustomer);
      case "BRAND_VOICE":
        return (draft.toneOfVoice?.length ?? 0) > 0;
      case "PLATFORMS":
        return (draft.platforms?.length ?? 0) > 0 && Boolean(draft.postingFrequency);
      case "FIRST_STRATEGY":
        return Boolean(draft.approvalPreference);
    }
  };

  const completedCount = STEPS.filter((_, i) => stepComplete(i)).length;
  const canAdvance = stepComplete(stepIndex);

  const goNext = async () => {
    await saveOnboardingDraftAction(draft);
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const result = await completeOnboardingAction(draft);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setDone(true);
    clearDraft();
    router.push("/plan");
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Stepper */}
      <Panel>
        <PanelBody className="pt-5">
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-4">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const active = i === stepIndex;
              const complete = stepComplete(i) && i !== stepIndex;
              return (
                <React.Fragment key={s.key}>
                  <li className="flex min-w-[92px] flex-col items-center gap-2 text-center">
                    <button
                      type="button"
                      onClick={() => setStepIndex(i)}
                      aria-current={active ? "step" : undefined}
                      className={cn(
                        "inline-flex size-10 items-center justify-center rounded-full border transition-colors",
                        active
                          ? "border-accent bg-accent/15 text-accent shadow-[0_0_0_4px_rgba(34,211,238,0.10)]"
                          : complete
                            ? "border-ok/40 bg-ok/10 text-ok"
                            : "border-hairline-strong bg-surface-3 text-ink-faint hover:text-ink-muted",
                      )}
                    >
                      {complete ? <Check className="size-4" /> : <Icon className="size-4" />}
                    </button>
                    <span className={cn("text-[11.5px] leading-tight", active ? "font-medium text-ink" : "text-ink-faint")}>
                      {s.label}
                    </span>
                  </li>
                  {i < STEPS.length - 1 ? (
                    <li aria-hidden className="hidden h-px min-w-6 flex-1 bg-hairline-strong sm:block" />
                  ) : null}
                </React.Fragment>
              );
            })}
          </ol>
        </PanelBody>
      </Panel>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* Checklist */}
        <div className="xl:col-span-3">
          <Panel>
            <PanelHeader eyebrow="Onboarding checklist" title={`${completedCount} of ${STEPS.length} steps complete`} />
            <PanelBody>
              <Progress value={(completedCount / STEPS.length) * 100} className="mb-4" />
              <ol className="flex flex-col gap-1">
                {STEPS.map((s, i) => {
                  const active = i === stepIndex;
                  const complete = stepComplete(i);
                  return (
                    <li key={s.key}>
                      <button
                        type="button"
                        onClick={() => setStepIndex(i)}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-[var(--radius-card)] border px-3 py-2.5 text-left transition-colors",
                          active
                            ? "border-accent/35 bg-accent/8"
                            : "border-transparent hover:border-hairline hover:bg-white/4",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                            complete
                              ? "border-ok/40 bg-ok/10 text-ok"
                              : active
                                ? "border-accent/45 bg-accent/12 text-accent"
                                : "border-hairline-strong text-ink-faint",
                          )}
                        >
                          {complete ? <Check className="size-3" /> : i + 1}
                        </span>
                        <span className="min-w-0">
                          <span className={cn("block text-[13px]", active ? "font-medium text-accent" : "text-ink")}>
                            {s.label}
                          </span>
                          <span className="block text-[11.5px] leading-snug text-ink-faint">{s.blurb}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </PanelBody>
          </Panel>
        </div>

        {/* Step form */}
        <div className="xl:col-span-6">
          <Panel>
            <PanelHeader
              eyebrow={step.label}
              title={step.blurb}
              action={<span className="text-[12px] text-ink-faint">Step {stepIndex + 1} of {STEPS.length}</span>}
            />
            <PanelBody className="flex flex-col gap-4">
              {step.key === "BUSINESS" ? (
                <>
                  <Field label="Company / brand name" required hint="Your business or personal brand name.">
                    <Input
                      value={draft.businessName ?? ""}
                      onChange={(e) => set("businessName", e.target.value)}
                      placeholder="ClipPilot AI"
                    />
                  </Field>
                  <Field label="Website" hint="Optional. Used for context and link-in-bio CTAs.">
                    <Input
                      type="url"
                      value={draft.website ?? ""}
                      onChange={(e) => set("website", e.target.value)}
                      placeholder="https://example.com"
                    />
                  </Field>
                  <Field label="Your niche" required hint="e.g. Fitness, Real Estate, E-commerce, Coaching, SaaS.">
                    <Select value={draft.niche ?? ""} onChange={(e) => set("niche", e.target.value)}>
                      <option value="">Select a niche</option>
                      {NICHES.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label="What do you offer?"
                    required
                    hint="Describe your main product or service."
                    counter={`${(draft.offer ?? "").length}/300`}
                  >
                    <Textarea
                      rows={3}
                      maxLength={300}
                      value={draft.offer ?? ""}
                      onChange={(e) => set("offer", e.target.value)}
                      placeholder="AI content systems for creators and brands. We script, edit, post and scale short-form content."
                    />
                  </Field>
                  <Field label="Products and services" hint="Comma separated.">
                    <Input
                      value={(draft.productsServices ?? []).join(", ")}
                      onChange={(e) => set("productsServices", splitList(e.target.value))}
                      placeholder="Done-for-you short form, Strategy retainer"
                    />
                  </Field>
                </>
              ) : null}

              {step.key === "GOALS" ? (
                <>
                  <Field label="Main business objective" required hint="What is your primary focus right now?">
                    <Select
                      value={draft.businessObjective ?? ""}
                      onChange={(e) => set("businessObjective", e.target.value)}
                    >
                      <option value="">Select an objective</option>
                      {OBJECTIVES.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Content goals" hint="Pick everything the content should be working towards.">
                    <TagPicker
                      options={CONTENT_GOALS}
                      selected={draft.contentGoals ?? []}
                      onToggle={(v) => toggleIn("contentGoals", v)}
                    />
                  </Field>
                  <Field label="Primary call to action" required hint="The one action every post should push towards.">
                    <Input
                      value={draft.primaryCta ?? ""}
                      onChange={(e) => set("primaryCta", e.target.value)}
                      placeholder="Book a free strategy call"
                    />
                  </Field>
                  <Field label="Competitors and inspiration" hint="Handles or brands, comma separated.">
                    <Input
                      value={(draft.competitors ?? []).join(", ")}
                      onChange={(e) => set("competitors", splitList(e.target.value))}
                      placeholder="@growthinpublic, @shortformlab"
                    />
                  </Field>
                </>
              ) : null}

              {step.key === "AUDIENCE" ? (
                <>
                  <Field
                    label="Who is your ideal customer?"
                    required
                    hint="Be specific about who you want to reach."
                    counter={`${(draft.idealCustomer ?? "").length}/300`}
                  >
                    <Textarea
                      rows={4}
                      maxLength={300}
                      value={draft.idealCustomer ?? ""}
                      onChange={(e) => set("idealCustomer", e.target.value)}
                      placeholder="Creators, coaches and small business owners who want to grow on social media but do not have time to create content."
                    />
                  </Field>
                  <Field label="Existing social links" hint="Comma separated. Used to read current performance.">
                    <Textarea
                      rows={2}
                      value={(draft.existingSocialLinks ?? []).join(", ")}
                      onChange={(e) => set("existingSocialLinks", splitList(e.target.value))}
                      placeholder="https://tiktok.com/@yourbrand, https://instagram.com/yourbrand"
                    />
                  </Field>
                </>
              ) : null}

              {step.key === "BRAND_VOICE" ? (
                <>
                  <Field label="Tone of voice" required hint="Pick two or three that genuinely fit.">
                    <TagPicker
                      options={TONES}
                      selected={draft.toneOfVoice ?? []}
                      onToggle={(v) => toggleIn("toneOfVoice", v)}
                    />
                  </Field>
                  <Field label="Words and phrases to use" hint="Comma separated.">
                    <Input
                      value={(draft.phrasesToUse ?? []).join(", ")}
                      onChange={(e) => set("phrasesToUse", splitList(e.target.value))}
                      placeholder="content system, turn attention into customers"
                    />
                  </Field>
                  <Field
                    label="Claims and words to avoid"
                    hint="Anything you are not willing to say. Compliance limits belong here."
                  >
                    <Input
                      value={(draft.claimsToAvoid ?? []).join(", ")}
                      onChange={(e) => set("claimsToAvoid", splitList(e.target.value))}
                      placeholder="guaranteed results, get rich quick"
                    />
                  </Field>
                </>
              ) : null}

              {step.key === "PLATFORMS" ? (
                <>
                  <Field label="Where do you want to post?" required hint="Select every platform in scope.">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {PLATFORMS.map((platform) => {
                        const active = (draft.platforms ?? []).includes(platform);
                        return (
                          <button
                            key={platform}
                            type="button"
                            aria-pressed={active}
                            onClick={() => togglePlatform(platform)}
                            className={cn(
                              "flex items-center gap-2.5 rounded-[var(--radius-card)] border px-3 py-2.5 text-left transition-colors",
                              active
                                ? "border-accent/45 bg-accent/10"
                                : "border-hairline-strong bg-surface-3/40 hover:border-accent/30",
                            )}
                          >
                            <span
                              className={cn(
                                "inline-flex size-7 items-center justify-center rounded-md text-[11px] font-semibold",
                                PLATFORM_META[platform].className,
                              )}
                            >
                              {PLATFORM_META[platform].short}
                            </span>
                            <span className={cn("text-[13px]", active ? "text-ink" : "text-ink-muted")}>
                              {PLATFORM_META[platform].label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </Field>
                  <Field label="Preferred posting frequency" required hint="We optimise the calendar around this.">
                    <Select
                      value={draft.postingFrequency ?? ""}
                      onChange={(e) => set("postingFrequency", e.target.value)}
                    >
                      <option value="">Select a frequency</option>
                      {FREQUENCIES.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="What raw assets do you already have?">
                    <div className="flex flex-col gap-2">
                      {ASSET_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={draft.assetAvailability === option.value}
                          onClick={() => set("assetAvailability", option.value)}
                          className={cn(
                            "rounded-[var(--radius-card)] border px-3.5 py-2.5 text-left transition-colors",
                            draft.assetAvailability === option.value
                              ? "border-accent/45 bg-accent/8"
                              : "border-hairline-strong bg-surface-3/40 hover:border-accent/30",
                          )}
                        >
                          <span className="block text-[13px] font-medium text-ink">{option.label}</span>
                          <span className="block text-[12px] text-ink-muted">{option.detail}</span>
                        </button>
                      ))}
                    </div>
                  </Field>
                </>
              ) : null}

              {step.key === "FIRST_STRATEGY" ? (
                <>
                  <Field label="Approval preference" required hint="You can change this later in Settings.">
                    <div className="flex flex-col gap-2">
                      {APPROVAL_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={draft.approvalPreference === option.value}
                          onClick={() => set("approvalPreference", option.value)}
                          className={cn(
                            "rounded-[var(--radius-card)] border px-3.5 py-2.5 text-left transition-colors",
                            draft.approvalPreference === option.value
                              ? "border-accent/45 bg-accent/8"
                              : "border-hairline-strong bg-surface-3/40 hover:border-accent/30",
                          )}
                        >
                          <span className="block text-[13px] font-medium text-ink">{option.label}</span>
                          <span className="block text-[12px] text-ink-muted">{option.detail}</span>
                        </button>
                      ))}
                    </div>
                  </Field>

                  <div className="rounded-[var(--radius-card)] border border-hairline bg-surface-2/60 p-4">
                    <p className="ss-eyebrow">What happens next</p>
                    <ol className="mt-2.5 flex flex-col gap-1.5 text-[12.5px] text-ink-muted">
                      <li>1. Your answers become the strategy brief.</li>
                      <li>2. The system drafts content pillars and a weekly cadence.</li>
                      <li>3. Briefs and scripts are generated against those pillars.</li>
                      <li>4. You review, approve and the calendar fills itself.</li>
                    </ol>
                  </div>

                  {error ? (
                    <p role="alert" className="text-[12.5px] text-danger">
                      {error}
                    </p>
                  ) : null}
                </>
              ) : null}
            </PanelBody>

            <div className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-4">
              <Button
                variant="ghost"
                onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                disabled={stepIndex === 0}
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>

              {stepIndex < STEPS.length - 1 ? (
                <Button variant="primary" onClick={goNext} disabled={!canAdvance}>
                  Next step
                  <ArrowRight className="size-4" />
                </Button>
              ) : (
                <Button variant="primary" onClick={submit} disabled={!canAdvance || submitting || done}>
                  {submitting ? <Loader2 className="size-4 animate-spin" /> : <Megaphone className="size-4" />}
                  {submitting ? "Generating..." : "Generate my content system"}
                </Button>
              )}
            </div>
          </Panel>
        </div>

        {/* Live summary */}
        <div className="xl:col-span-3">
          <Panel className="xl:sticky xl:top-20">
            <PanelHeader
              eyebrow="Your setup summary"
              title="Live preview"
              description="How your answers will be used."
              action={<Badge className="border-hairline bg-white/6 text-ink-muted">Draft</Badge>}
            />
            <PanelBody>
              <div className="rounded-[var(--radius-card)] border border-accent/18 bg-[linear-gradient(160deg,rgba(34,211,238,0.08),rgba(10,15,24,0.9))] p-4">
                <p className="text-[17px] font-semibold text-ink">{draft.businessName || "Your brand"}</p>
                <p className="mt-1 text-[12.5px] leading-snug text-ink-muted">
                  {draft.offer || "Your offer will appear here once you describe it."}
                </p>
              </div>

              <dl className="mt-4 flex flex-col">
                {[
                  ["Niche", draft.niche],
                  ["Objective", draft.businessObjective],
                  ["Ideal customer", draft.idealCustomer],
                  ["Tone", draft.toneOfVoice?.join(", ")],
                  ["Platforms", draft.platforms?.map((p) => PLATFORM_META[p].label).join(", ")],
                  ["Frequency", draft.postingFrequency],
                  ["Approvals", APPROVAL_OPTIONS.find((o) => o.value === draft.approvalPreference)?.label],
                ].map(([label, value]) => (
                  <div key={label as string} className="border-b border-hairline py-2.5 last:border-b-0">
                    <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
                    <dd className="mt-0.5 line-clamp-2 text-[12.5px] text-ink">
                      {value ? String(value) : <span className="text-ink-faint">Not set yet</span>}
                    </dd>
                  </div>
                ))}
              </dl>

              <p className="mt-4 text-[11.5px] leading-snug text-ink-faint">
                You can edit any of this later in Settings. Nothing is published without your approval.
              </p>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </div>
  );
}
