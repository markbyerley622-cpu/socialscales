"use client";

import * as React from "react";
import { Check, Info, Save } from "lucide-react";

import {
  Badge,
  Button,
  Field,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  Select,
  Textarea,
} from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/tabs";
import { PLATFORM_META } from "@/lib/display";
import type { BrandProfile, Workspace } from "@/lib/social-scales/contracts";
import { PLATFORMS } from "@/lib/social-scales/contracts";
import { usePersistentObject } from "@/lib/use-persistent-object";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "social-scales.settings.v1";

const SECTIONS = [
  { value: "WORKSPACE", label: "Workspace" },
  { value: "BRAND", label: "Brand" },
  { value: "CONTENT", label: "Content defaults" },
  { value: "APPROVALS", label: "Approval rules" },
  { value: "NOTIFICATIONS", label: "Notifications" },
  { value: "ADVANCED", label: "Advanced" },
] as const;

type Section = (typeof SECTIONS)[number]["value"];

interface LocalSettings {
  contentGoalsNote: string;
  defaultPlatform: string;
  defaultDurationSec: number;
  autoCaptions: boolean;
  approvalPreference: BrandProfile["approvalPreference"];
  notifyApprovals: boolean;
  notifyWeeklyReport: boolean;
  notifyFailures: boolean;
}

const DEFAULTS: LocalSettings = {
  contentGoalsNote: "",
  defaultPlatform: "TIKTOK",
  defaultDurationSec: 30,
  autoCaptions: true,
  approvalPreference: "REVIEW_EVERYTHING",
  notifyApprovals: true,
  notifyWeeklyReport: true,
  notifyFailures: true,
};

function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start justify-between gap-4 rounded-[var(--radius-card)] border border-hairline bg-surface-2/50 px-4 py-3 text-left transition-colors hover:border-accent/25"
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink">{label}</span>
        <span className="block text-[12px] leading-snug text-ink-muted">{detail}</span>
      </span>
      <span
        className={cn(
          "mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
          checked ? "border-accent/50 bg-accent/25" : "border-hairline-strong bg-surface-3",
        )}
      >
        <span
          className={cn(
            "mx-0.5 size-3.5 rounded-full transition-transform",
            checked ? "translate-x-4 bg-accent" : "bg-ink-faint",
          )}
        />
      </span>
    </button>
  );
}

export function SettingsWorkspace({
  workspace,
  profile,
  dataMode,
}: {
  workspace: Workspace;
  profile: Partial<BrandProfile>;
  dataMode: "mock" | "http";
}) {
  const [section, setSection] = React.useState<Section>("WORKSPACE");
  const [saved, setSaved] = React.useState(false);

  const { value: settings, update: setSettings } = usePersistentObject<LocalSettings>(STORAGE_KEY, DEFAULTS);

  const set = <K extends keyof LocalSettings>(key: K, value: LocalSettings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setSaved(false);
  };

  // Changes persist as they are made; this only acknowledges them.
  const save = () => setSaved(true);

  return (
    <div className="flex flex-col gap-5">
      <Tabs
        ariaLabel="Settings section"
        items={SECTIONS.map((s) => ({ ...s }))}
        value={section}
        onChange={setSection}
        className="w-full"
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="xl:col-span-8">
          <Panel>
            <PanelHeader
              eyebrow={SECTIONS.find((s) => s.value === section)?.label}
              title={
                section === "WORKSPACE"
                  ? "Workspace identity"
                  : section === "BRAND"
                    ? "Brand profile"
                    : section === "CONTENT"
                      ? "Defaults applied to new content"
                      : section === "APPROVALS"
                        ? "Who has to say yes"
                        : section === "NOTIFICATIONS"
                          ? "What you get told about"
                          : "Data source and diagnostics"
              }
            />
            <PanelBody className="flex flex-col gap-4">
              {section === "WORKSPACE" ? (
                <>
                  <Field label="Workspace name" hint="Managed by the backend account record.">
                    <Input defaultValue={workspace.name} disabled />
                  </Field>
                  <Field label="Tagline">
                    <Input defaultValue={workspace.tagline} disabled />
                  </Field>
                  <Field label="Owner">
                    <Input defaultValue={`${workspace.ownerName} · ${workspace.ownerRole}`} disabled />
                  </Field>
                  <p className="text-[12px] text-ink-faint">
                    Workspace records are owned by the backend. These fields become editable once the HTTP adapter is
                    connected.
                  </p>
                </>
              ) : null}

              {section === "BRAND" ? (
                <>
                  <Field label="Business name">
                    <Input defaultValue={profile.businessName ?? ""} disabled />
                  </Field>
                  <Field label="Niche">
                    <Input defaultValue={profile.niche ?? ""} disabled />
                  </Field>
                  <Field label="Offer">
                    <Textarea rows={3} defaultValue={profile.offer ?? ""} disabled />
                  </Field>
                  <Field label="Tone of voice">
                    <Input defaultValue={(profile.toneOfVoice ?? []).join(", ")} disabled />
                  </Field>
                  <Field label="Claims to avoid" hint="Compliance limits enforced on every generated script.">
                    <Input defaultValue={(profile.claimsToAvoid ?? []).join(", ")} disabled />
                  </Field>
                  <p className="text-[12px] text-ink-faint">
                    Brand answers come from onboarding. Re-run onboarding to change them in the standalone build.
                  </p>
                </>
              ) : null}

              {section === "CONTENT" ? (
                <>
                  <Field label="Default platform" hint="Applied to new ideas that do not specify one.">
                    <Select
                      value={settings.defaultPlatform}
                      onChange={(e) => set("defaultPlatform", e.target.value)}
                    >
                      {PLATFORMS.map((p) => (
                        <option key={p} value={p}>
                          {PLATFORM_META[p].label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Target duration (seconds)" hint="The length scripts are written towards.">
                    <Input
                      type="number"
                      min={10}
                      max={180}
                      value={settings.defaultDurationSec}
                      onChange={(e) => set("defaultDurationSec", Number(e.target.value))}
                    />
                  </Field>
                  <Toggle
                    label="Auto captions"
                    detail="Burn captions into every generated cut by default."
                    checked={settings.autoCaptions}
                    onChange={(v) => set("autoCaptions", v)}
                  />
                  <Field label="Standing note for the content system" hint="Free text passed into every plan.">
                    <Textarea
                      rows={4}
                      value={settings.contentGoalsNote}
                      onChange={(e) => set("contentGoalsNote", e.target.value)}
                      placeholder="e.g. Push the September launch until the 30th. Avoid competitor comparisons."
                    />
                  </Field>
                </>
              ) : null}

              {section === "APPROVALS" ? (
                <Field label="Approval preference">
                  <div className="flex flex-col gap-2">
                    {(
                      [
                        ["REVIEW_EVERYTHING", "Review everything", "Nothing publishes without your approval."],
                        ["REVIEW_FIRST_WEEK", "Review the first week", "Then auto-publish once you trust the output."],
                        ["AUTO_PUBLISH", "Auto-publish", "Publish on schedule; you can still pull anything back."],
                      ] as const
                    ).map(([value, label, detail]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={settings.approvalPreference === value}
                        onClick={() => set("approvalPreference", value)}
                        className={cn(
                          "rounded-[var(--radius-card)] border px-3.5 py-2.5 text-left transition-colors",
                          settings.approvalPreference === value
                            ? "border-accent/45 bg-accent/8"
                            : "border-hairline-strong bg-surface-3/40 hover:border-accent/30",
                        )}
                      >
                        <span className="block text-[13px] font-medium text-ink">{label}</span>
                        <span className="block text-[12px] text-ink-muted">{detail}</span>
                      </button>
                    ))}
                  </div>
                </Field>
              ) : null}

              {section === "NOTIFICATIONS" ? (
                <>
                  <Toggle
                    label="Approval requests"
                    detail="Tell me when content is waiting on my review."
                    checked={settings.notifyApprovals}
                    onChange={(v) => set("notifyApprovals", v)}
                  />
                  <Toggle
                    label="Weekly performance report"
                    detail="A summary of what shipped and what it did."
                    checked={settings.notifyWeeklyReport}
                    onChange={(v) => set("notifyWeeklyReport", v)}
                  />
                  <Toggle
                    label="Generation failures"
                    detail="Alert me when a render or a publish fails."
                    checked={settings.notifyFailures}
                    onChange={(v) => set("notifyFailures", v)}
                  />
                  <p className="text-[12px] text-ink-faint">
                    Delivery (email, Slack, push) is a backend concern. These preferences are stored locally in the
                    standalone build.
                  </p>
                </>
              ) : null}

              {section === "ADVANCED" ? (
                <>
                  <div className="rounded-[var(--radius-card)] border border-hairline bg-surface-2/50 p-4">
                    <p className="ss-eyebrow">Data source</p>
                    <div className="mt-2.5 flex items-center gap-2">
                      <Badge
                        className={
                          dataMode === "mock"
                            ? "border-warn/28 bg-warn/10 text-warn"
                            : "border-ok/25 bg-ok/10 text-ok"
                        }
                        dot={dataMode === "mock" ? "bg-warn" : "bg-ok"}
                      >
                        {dataMode === "mock" ? "Mock adapter" : "HTTP adapter"}
                      </Badge>
                      <span className="text-[12.5px] text-ink-muted">
                        {dataMode === "mock"
                          ? "Reading from local development fixtures."
                          : "Reading from the configured Social Scales backend."}
                      </span>
                    </div>
                    <pre className="ss-scrollbar mt-3 overflow-x-auto rounded-md border border-hairline bg-canvas p-3 text-[11.5px] leading-relaxed text-ink-muted">
{`SOCIAL_SCALES_DATA_MODE=${dataMode}
NEXT_PUBLIC_SOCIAL_SCALES_API_URL=<backend base url>`}
                    </pre>
                    <p className="mt-3 text-[12px] leading-relaxed text-ink-faint">
                      Switching modes is a restart of the dev server, not a code change. See INTEGRATION.md.
                    </p>
                  </div>

                  <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-hairline bg-surface-2/50 p-4">
                    <Info className="mt-0.5 size-4 shrink-0 text-accent" />
                    <p className="text-[12.5px] leading-relaxed text-ink-muted">
                      Destructive operations (delete workspace, rotate API keys, export data) are intentionally absent.
                      They require real authentication and a real backend.
                    </p>
                  </div>
                </>
              ) : null}
            </PanelBody>

            {section === "CONTENT" || section === "APPROVALS" || section === "NOTIFICATIONS" ? (
              <div className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-4">
                <span className="text-[12px] text-ink-faint">
                  Saved to this browser only until the backend is connected.
                </span>
                <Button variant="primary" size="sm" onClick={save}>
                  {saved ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
                  {saved ? "Saved" : "Save preferences"}
                </Button>
              </div>
            ) : null}
          </Panel>
        </div>

        <div className="xl:col-span-4">
          <Panel>
            <PanelHeader eyebrow="Summary" title="Current configuration" />
            <PanelBody>
              <dl className="flex flex-col">
                {[
                  ["Workspace", workspace.name],
                  ["Plan", workspace.plan],
                  ["Brand", profile.businessName ?? "Not set"],
                  ["Platforms", (profile.platforms ?? []).map((p) => PLATFORM_META[p].label).join(", ") || "None"],
                  ["Cadence", profile.postingFrequency ?? "Not set"],
                  ["Default platform", PLATFORM_META[settings.defaultPlatform as keyof typeof PLATFORM_META]?.label ?? "—"],
                  ["Target duration", `${settings.defaultDurationSec}s`],
                  ["Data source", dataMode === "mock" ? "Mock fixtures" : "Backend API"],
                ].map(([label, value]) => (
                  <div key={label} className="border-b border-hairline py-2.5 last:border-b-0">
                    <dt className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</dt>
                    <dd className="mt-0.5 text-[12.5px] text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </div>
  );
}
