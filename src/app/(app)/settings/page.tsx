import type { Metadata } from "next";

import { PageHero } from "@/components/shell/page-hero";
import { SettingsWorkspace } from "@/features/settings/settings-workspace";
import { getAdapter, resolveDataMode } from "@/lib/social-scales";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const adapter = getAdapter();
  const [workspace, onboarding] = await Promise.all([adapter.getWorkspace(), adapter.getOnboardingState()]);

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="Workspace"
        accentWord="settings"
        subtitle="Brand context, content defaults and the rules the system operates under."
        kicker={["Brand", "Defaults", "Approvals", "Notifications"]}
      />

      <SettingsWorkspace workspace={workspace} profile={onboarding.draft} dataMode={resolveDataMode()} />
    </div>
  );
}
