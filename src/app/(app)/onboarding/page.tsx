import type { Metadata } from "next";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { PageHero } from "@/components/shell/page-hero";
import { OnboardingWizard } from "@/features/onboarding/onboarding-wizard";
import { getAdapter } from "@/lib/social-scales";

export const metadata: Metadata = { title: "Onboarding" };

export default async function OnboardingPage() {
  const state = await getAdapter().getOnboardingState();

  return (
    <div className="flex flex-col gap-5">
      <Link
        href="/dashboard"
        className="inline-flex w-fit items-center gap-2 text-[13px] text-ink-muted transition-colors hover:text-accent"
      >
        <ArrowLeft className="size-4" />
        Back to dashboard
      </Link>

      <PageHero
        title="Content system"
        accentWord="onboarding"
        subtitle="Set up the business context once. Everything the system plans, writes and schedules comes from these answers."
        kicker={["Business", "Goals", "Audience", "Voice", "Platforms", "Strategy"]}
      />

      <OnboardingWizard initialState={state} />
    </div>
  );
}
