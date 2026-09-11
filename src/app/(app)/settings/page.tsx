import type { Metadata } from "next";

import { PageHero } from "@/components/shell/page-hero";
import { ErrorState } from "@/components/ui/primitives";
import { SettingsWorkspace } from "@/features/settings/settings-workspace";
import { getAdapter, resolveDataSource } from "@/lib/social-scales";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

const LABELS = {
  prisma: "Live database",
  http: "HTTP backend",
  mock: "Development fixtures",
} as const;

export default async function SettingsPage() {
  // Resolved before the adapter is touched. A misconfigured deployment has to
  // be able to *say so on this screen* — which it cannot do if loading the
  // workspace throws first, and cannot do reliably through the error boundary
  // either, because Next replaces server error messages with an opaque digest
  // in production builds.
  const source = resolveDataSource();

  if (!source.ok) {
    return (
      <div className="flex flex-col gap-5">
        <PageHero
          title="Workspace"
          accentWord="settings"
          subtitle="Brand context, content defaults and the rules the system operates under."
          kicker={["Brand", "Defaults", "Approvals", "Notifications"]}
        />
        <ErrorState
          title="Backend unavailable — this deployment is not configured"
          detail={`${source.problem} Nothing is being shown from fixtures: this screen is empty because the real data source cannot be reached, which is deliberate.`}
        />
      </div>
    );
  }

  const adapter = getAdapter();
  const [workspace, onboarding] = await Promise.all([
    adapter.getWorkspace(),
    adapter.getOnboardingState(),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="Workspace"
        accentWord="settings"
        subtitle="Brand context, content defaults and the rules the system operates under."
        kicker={["Brand", "Defaults", "Approvals", "Notifications"]}
      />

      <SettingsWorkspace
        workspace={workspace}
        profile={onboarding.draft}
        dataSource={{
          mode: source.mode,
          label: LABELS[source.mode],
          summary: source.summary,
          isDemo: source.isDemo,
        }}
      />
    </div>
  );
}
