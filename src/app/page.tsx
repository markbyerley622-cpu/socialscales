import { redirect } from "next/navigation";

import { getAdapter } from "@/lib/social-scales";

/**
 * Entry point. A workspace that has not finished onboarding has nothing to show
 * on the dashboard, so it goes to the setup flow instead.
 */
export const dynamic = "force-dynamic";

export default async function RootPage() {
  const onboarding = await getAdapter().getOnboardingState();
  redirect(onboarding.complete ? "/dashboard" : "/onboarding");
}
