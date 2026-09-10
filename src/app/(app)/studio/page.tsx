import type { Metadata } from "next";

import { PageHero } from "@/components/shell/page-hero";
import { LinkButton } from "@/components/ui/primitives";
import { StudioWorkspace } from "@/features/studio/studio-workspace";
import { getAdapter, isAdapterError } from "@/lib/social-scales";
import { ErrorState } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Content Studio" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function StudioPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const raw = params.contentItemId;
  const contentItemId = Array.isArray(raw) ? raw[0] : raw;

  let view;
  try {
    view = await getAdapter().getStudio(contentItemId);
  } catch (error) {
    return (
      <div className="flex flex-col gap-5">
        <PageHero
          title="Content"
          accentWord="Studio"
          subtitle="Turn ideas into on-brand posts."
          kicker={["Ideas", "Script", "Assets", "Preview", "Publish"]}
        />
        <ErrorState
          title="That content item could not be loaded"
          detail={isAdapterError(error) ? error.message : "Unknown error."}
          action={<LinkButton href="/content" size="sm" variant="secondary">Back to the content queue</LinkButton>}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHero
        title="Content"
        accentWord="Studio"
        subtitle="Turn ideas into high-performing content. Script it, cut it, preview it, ship it."
        kicker={["Ideas", "Script", "Assets", "Preview", "Publish"]}
        actions={<LinkButton href="/content" variant="secondary">Back to queue</LinkButton>}
      />

      <StudioWorkspace view={view} />
    </div>
  );
}
