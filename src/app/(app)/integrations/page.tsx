import type { Metadata } from "next";
import { Film, Info, Share2 } from "lucide-react";

import { PageHero } from "@/components/shell/page-hero";
import { IntegrationBadge } from "@/components/ui/data-display";
import { Panel, PanelBody, PanelHeader } from "@/components/ui/primitives";
import { getAdapter } from "@/lib/social-scales";
import type { IntegrationProvider } from "@/lib/social-scales/contracts";
import { relativeFrom } from "@/lib/utils";

export const metadata: Metadata = { title: "Integrations" };

function ProviderCard({ provider, now }: { provider: IntegrationProvider; now: Date }) {
  return (
    <li className="flex flex-col rounded-[var(--radius-card)] border border-hairline bg-surface-2/55 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-10 items-center justify-center rounded-lg border border-hairline-strong bg-surface-3 text-accent">
            {provider.category === "GENERATION" ? <Film className="size-4" /> : <Share2 className="size-4" />}
          </span>
          <div>
            <p className="text-[14px] font-semibold text-ink">{provider.name}</p>
            <p className="text-[11.5px] text-ink-faint">
              {provider.accountLabel ?? "No account linked"}
            </p>
          </div>
        </div>
        <IntegrationBadge status={provider.status} />
      </div>

      <p className="mt-3 flex-1 text-[12.5px] leading-relaxed text-ink-muted">{provider.detail}</p>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-hairline pt-3">
        <span className="text-[11px] text-ink-faint">
          {provider.lastSyncedAt ? `Last synced ${relativeFrom(provider.lastSyncedAt, now)}` : "Never synced"}
        </span>
        <button
          type="button"
          disabled={!provider.actionsEnabled}
          title="OAuth and token storage live in the backend. The standalone frontend cannot connect a real account."
          className="inline-flex h-8 cursor-not-allowed items-center rounded-[var(--radius-control)] border border-hairline bg-surface-3/40 px-3 text-[12px] text-ink-faint"
        >
          {provider.status === "CONNECTED" ? "Disconnect" : "Connect"} — backend only
        </button>
      </div>
    </li>
  );
}

export default async function IntegrationsPage() {
  const integrations = await getAdapter().getIntegrations();
  const now = new Date();

  const social = integrations.filter((i) => i.category === "SOCIAL");
  const generation = integrations.filter((i) => i.category === "GENERATION");

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="Platform"
        accentWord="integrations"
        subtitle="Where the system publishes, and where it reads performance back from."
        kicker={["Connect", "Publish", "Measure"]}
      />

      <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-accent/22 bg-accent/6 px-4 py-3.5">
        <Info className="mt-0.5 size-4 shrink-0 text-accent" />
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          Connection state shown here is fixture data. Real OAuth flows, token refresh and revocation are the
          backend&rsquo;s responsibility — this screen only renders whatever status the adapter reports, so it works
          unchanged once the backend is wired in.
        </p>
      </div>

      <Panel>
        <PanelHeader
          eyebrow="Social platforms"
          title={`${social.filter((s) => s.status === "CONNECTED").length} of ${social.length} connected`}
        />
        <PanelBody>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {social.map((provider) => (
              <ProviderCard key={provider.id} provider={provider} now={now} />
            ))}
          </ul>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          eyebrow="Generation"
          title="Video render pipeline"
          description="Reserved seam. The frontend already models generation jobs end to end."
        />
        <PanelBody>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {generation.map((provider) => (
              <ProviderCard key={provider.id} provider={provider} now={now} />
            ))}
          </ul>

          <div className="mt-4 rounded-[var(--radius-card)] border border-hairline bg-surface-2/50 p-4">
            <p className="ss-eyebrow">Generation contract</p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
              A render provider supplies a <code className="text-accent">GenerationJob</code>: id, status, progress,
              preview URL, final video URL, thumbnail, QA status and failure reason. Nothing in the UI depends on which
              provider produces it.
            </p>
            <pre className="ss-scrollbar mt-3 overflow-x-auto rounded-md border border-hairline bg-canvas p-3 text-[11.5px] leading-relaxed text-ink-muted">
{`QUEUED → PLANNING → GENERATING → RENDERING → QA → READY
                                          └─→ FAILED`}
            </pre>
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}
