import type { Metadata } from "next";
import { CheckCircle2 } from "lucide-react";
import { prisma } from "@/server/db";
import { getAdapter } from "@/server/platforms/registry";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import {
  Card,
  CardHeader,
  EmptyState,
  ProjectDot,
} from "@/components/ui/primitives";
import { ApprovalPanel } from "@/components/posts/approval-panel";
import { PolicyBadge } from "@/components/ui/status";
import { platformLabel } from "@/components/ui/status";
import { relativeTime } from "@/lib/utils";
import { ApprovalState } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Approvals" };
export const dynamic = "force-dynamic";

/**
 * Everything waiting on a human. Manual approval is the default policy, so this
 * is the busiest screen in normal operation.
 */
export default async function ApprovalsPage() {
  const posts = await prisma.post.findMany({
    where: { approvalState: ApprovalState.PENDING },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
    include: {
      project: { select: { name: true, accentColor: true, publishPolicy: true } },
      variant: true,
      asset: true,
      targets: { include: { account: { select: { handle: true } } } },
    },
  });

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Nothing here has been queued. Approving a post is what hands it to the publishing worker."
      />

      <PageBody className="space-y-4">
        {posts.length === 0 ? (
          <Card>
            <EmptyState
              icon={<CheckCircle2 />}
              title="Nothing waiting"
              body="Every post has been decided. New posts appear here whenever a project's policy requires review."
            />
          </Card>
        ) : (
          posts.map((post) => {
            // Re-check platform fit at approval time, not just at creation.
            const warnings = post.targets.flatMap((target) => {
              const verdict = getAdapter(target.platform).validateMedia({
                mimeType: post.asset.mimeType,
                sizeBytes: post.asset.sizeBytes,
                durationSeconds: post.asset.durationSeconds,
                aspectRatio: post.asset.aspectRatio,
              });
              return verdict.issues
                .filter((issue) => issue.severity === "warning")
                .map((issue) => `${platformLabel(target.platform)}: ${issue.message}`);
            });

            return (
              <Card key={post.id} className="animate-fade-up">
                <CardHeader
                  title={
                    <span className="inline-flex items-center gap-2">
                      <ProjectDot color={post.project.accentColor} />
                      {post.project.name}
                    </span>
                  }
                  subtitle={`Created ${relativeTime(post.createdAt)}${
                    post.scheduledFor
                      ? ` · proposed for ${post.scheduledFor.toLocaleString()}`
                      : " · no time proposed yet"
                  }`}
                  action={<PolicyBadge policy={post.project.publishPolicy} />}
                />
                <ApprovalPanel
                  postId={post.id}
                  assetId={post.assetId}
                  hook={post.variant.hook}
                  caption={post.variant.caption}
                  hashtags={post.variant.hashtags}
                  cta={post.variant.cta}
                  variantLabel={post.variant.label}
                  assetTitle={post.asset.title}
                  assetDuration={post.asset.durationSeconds}
                  assetAspect={post.asset.aspectRatio}
                  targets={post.targets.map((target) => ({
                    platform: target.platform,
                    handle: target.account.handle,
                  }))}
                  defaultScheduledFor={toLocalInputValue(
                    post.scheduledFor ?? nextHour(),
                  )}
                  warnings={warnings}
                />
              </Card>
            );
          })
        )}
      </PageBody>
    </>
  );
}

function nextHour(): Date {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date;
}

function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
