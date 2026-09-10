import type { Metadata } from "next";

import { PageHero } from "@/components/shell/page-hero";
import { SettingsWorkspace } from "@/features/settings/settings-workspace";
import { getAdapter, resolveDataSource } from "@/lib/social-scales";

export const metadata: Metadata = { title: "Settings" };

const LABELS = {
  prisma: "Live database",
  http: "HTTP backend",
  mock: "Development fixtures",
} as const;

export default async function SettingsPage() {
  const adapter = getAdapter();
  // Reported, not inferred: this is the same resolution the adapter used, so
  // the screen cannot claim one source while the data came from another.
  const source = resolveDataSource();
  const [workspace, onboarding] = await Promise.all([adapter.getWorkspace(), adapter.getOnboardingState()]);

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
        dataSource={
          source.ok
            ? {
                mode: source.mode,
                label: LABELS[source.mode],
                summary: source.summary,
                isDemo: source.isDemo,
              }
            : {
                mode: source.requested,
                label: "Misconfigured",
                summary: source.problem,
                isDemo: false,
              }
        }
      />
    </div>
  );
}
