import type { Metadata } from "next";
import Link from "next/link";
import { Video } from "lucide-react";
import { prisma } from "@/server/db";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardHeader,
  EmptyState,
  ProjectDot,
} from "@/components/ui/primitives";
import { UploadDropzone } from "@/components/content/upload-dropzone";
import { AssetThumb } from "@/components/content/asset-thumb";
import { Badge } from "@/components/ui/primitives";
import { bytes, humanize, relativeTime } from "@/lib/utils";
import { AssetStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Content" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<AssetStatus, "neutral" | "accent" | "good" | "critical"> = {
  UPLOADED: "neutral",
  ANALYZING: "accent",
  ANALYZED: "good",
  ANALYSIS_FAILED: "critical",
  ARCHIVED: "neutral",
};

export default async function ContentPage(props: PageProps<"/content">) {
  const params = await props.searchParams;
  const projectSlug = typeof params.project === "string" ? params.project : undefined;

  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    include: { pillars: { orderBy: { name: "asc" } } },
  });

  if (projects.length === 0) {
    return (
      <>
        <PageHeader title="Content library" />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Video />}
              title="No projects to upload into"
              body="Create a project first — content is always owned by one project."
            />
          </Card>
        </PageBody>
      </>
    );
  }

  const active =
    projects.find((project) => project.slug === projectSlug) ?? projects[0];

  const assets = await prisma.contentAsset.findMany({
    where: { projectId: active.id, status: { not: AssetStatus.ARCHIVED } },
    orderBy: { createdAt: "desc" },
    include: {
      pillar: { select: { name: true } },
      analyses: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { variants: true, posts: true } },
    },
  });

  return (
    <>
      <PageHeader
        title="Content library"
        description="You supply the creative. The system stores it, reads what it can from the file itself, and drafts the copy around it."
      />

      <PageBody className="space-y-4">
        {/* Project switcher: content is scoped to exactly one project. */}
        <nav aria-label="Project" className="flex flex-wrap gap-1.5">
          {projects.map((project) => {
            const isActive = project.id === active.id;
            return (
              <Link
                key={project.id}
                href={`/content?project=${project.slug}`}
                aria-current={isActive ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                  isActive
                    ? "border-hairline-strong bg-surface-raised text-ink"
                    : "border-hairline bg-surface text-ink-secondary hover:text-ink"
                }`}
              >
                <ProjectDot color={project.accentColor} />
                {project.name}
              </Link>
            );
          })}
        </nav>

        <Card>
          <CardHeader
            title={`Upload to ${active.name}`}
            subtitle="Every upload is validated by its own bytes, fingerprinted against the project, probed for duration and dimensions, then handed to the AI layer for hook, caption, hashtag and CTA suggestions."
          />
          <div className="px-4 py-4">
            <UploadDropzone
              projectId={active.id}
              projectName={active.name}
              pillars={active.pillars.map((pillar) => ({
                id: pillar.id,
                name: pillar.name,
              }))}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Library"
            subtitle={`${assets.length} asset${assets.length === 1 ? "" : "s"} in ${active.name}.`}
          />
          {assets.length === 0 ? (
            <EmptyState
              icon={<Video />}
              title="Nothing uploaded yet"
              body="Drop a file above. It will appear here with its probed facts and AI-drafted copy variants."
            />
          ) : (
            <ul className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {assets.map((asset) => (
                <li key={asset.id}>
                  <Link
                    href={`/content/${asset.id}`}
                    className="group block rounded-[10px] border border-hairline bg-surface p-2.5 transition-colors hover:border-hairline-strong hover:bg-surface-raised"
                  >
                    <AssetThumb
                      kind={asset.kind}
                      storageKey={asset.storageKey}
                      mimeType={asset.mimeType}
                      aspectRatio={asset.aspectRatio}
                      durationSeconds={asset.durationSeconds}
                      hasAudio={asset.hasAudio}
                      accentColor={active.accentColor}
                      className="aspect-[4/5] w-full"
                    />

                    <div className="mt-2.5">
                      <p className="truncate text-[12.5px] font-medium text-ink">
                        {asset.title}
                      </p>
                      <p className="mt-0.5 truncate text-[10.5px] text-ink-muted">
                        {asset.pillar?.name ?? "No pillar"} · {bytes(asset.sizeBytes)} ·{" "}
                        {relativeTime(asset.createdAt)}
                      </p>
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge tone={STATUS_TONE[asset.status]}>
                        {humanize(asset.status)}
                      </Badge>
                      {asset.analyses[0]?.format ? (
                        <Badge tone="neutral">
                          {humanize(asset.analyses[0].format)}
                        </Badge>
                      ) : null}
                      <span className="text-[10.5px] tabular text-ink-muted">
                        {asset._count.variants} variant
                        {asset._count.variants === 1 ? "" : "s"}
                      </span>
                      {asset._count.posts > 0 ? (
                        <span className="text-[10.5px] tabular text-ink-muted">
                          · {asset._count.posts} post
                          {asset._count.posts === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </>
  );
}
