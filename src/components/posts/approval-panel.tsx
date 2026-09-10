"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, ThumbsDown } from "lucide-react";
import { approvePostAction, rejectPostAction } from "@/app/actions/posts";
import { ActionForm } from "@/components/ui/action-form";
import { Button, SubmitButton } from "@/components/ui/button";
import { Badge, SectionLabel } from "@/components/ui/primitives";
import { PlatformBadge } from "@/components/ui/status";
import { duration } from "@/lib/utils";
import type { Platform } from "@/generated/prisma/enums";

/**
 * The approval gate the spec asks for: the full post shown as it will go out —
 * video, hook, caption, hashtags, CTA, platforms, accounts, schedule — with
 * approve, edit and reject.
 */
export function ApprovalPanel({
  postId,
  assetId,
  hook,
  caption,
  hashtags,
  cta,
  variantLabel,
  targets,
  defaultScheduledFor,
  assetTitle,
  assetDuration,
  assetAspect,
  warnings,
}: {
  postId: string;
  assetId: string;
  hook: string;
  caption: string;
  hashtags: string[];
  cta: string;
  variantLabel: string;
  targets: Array<{ platform: Platform; handle: string }>;
  defaultScheduledFor: string;
  assetTitle: string;
  assetDuration: number | null;
  assetAspect: string | null;
  warnings: string[];
}) {
  const [rejecting, setRejecting] = useState(false);

  return (
    <div className="space-y-3 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="neutral">{variantLabel}</Badge>
        {targets.map((target, index) => (
          <PlatformBadge key={index} platform={target.platform} />
        ))}
        <span className="text-[10.5px] text-ink-muted">
          {assetTitle} · {duration(assetDuration)}
          {assetAspect ? ` · ${assetAspect}` : ""}
        </span>
      </div>

      <div>
        <SectionLabel>Hook</SectionLabel>
        <p className="mt-1 text-[14px] font-medium leading-snug text-ink">{hook}</p>
      </div>

      <div>
        <SectionLabel>Caption</SectionLabel>
        <p className="mt-1 whitespace-pre-line text-[12px] leading-relaxed text-ink-secondary">
          {caption}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <SectionLabel>Hashtags</SectionLabel>
          <p className="mt-1 text-[11.5px] leading-relaxed text-accent-ink">
            {hashtags.length > 0 ? hashtags.join(" ") : "—"}
          </p>
        </div>
        <div>
          <SectionLabel>Call to action</SectionLabel>
          <p className="mt-1 text-[11.5px] text-ink-secondary">{cta || "—"}</p>
        </div>
      </div>

      <div>
        <SectionLabel>Accounts</SectionLabel>
        <ul className="mt-1 space-y-0.5">
          {targets.map((target, index) => (
            <li key={index} className="text-[11.5px] text-ink-secondary">
              {target.handle}
            </li>
          ))}
        </ul>
      </div>

      {warnings.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-warning/30 bg-warning/8 px-2.5 py-2">
          {warnings.map((warning, index) => (
            <li key={index} className="text-[10.5px] leading-relaxed text-[#f6c455]">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}

      {rejecting ? (
        <ActionForm
          action={rejectPostAction}
          className="space-y-2 rounded-md border border-critical/35 bg-critical/8 px-2.5 py-2.5"
        >
          <input type="hidden" name="postId" value={postId} />
          <label className="block">
            <SectionLabel>Why is this being rejected?</SectionLabel>
            <textarea
              name="reason"
              required
              rows={2}
              placeholder="Hook is too long for the first frame."
              className="mt-1 w-full resize-y rounded-md border border-hairline-strong bg-surface px-2 py-1.5 text-[12px] text-ink placeholder:text-ink-muted"
            />
          </label>
          <div className="flex items-center gap-2">
            <SubmitButton variant="danger" size="sm" pendingLabel="Rejecting…">
              Confirm rejection
            </SubmitButton>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRejecting(false)}
            >
              Cancel
            </Button>
          </div>
          <p className="text-[10.5px] leading-relaxed text-ink-muted">
            The reason is kept on the post and in the activity log, so the next
            person can see why.
          </p>
        </ActionForm>
      ) : (
        <ActionForm
          action={approvePostAction}
          className="flex flex-wrap items-end gap-2.5 border-t border-hairline pt-3"
        >
          <input type="hidden" name="postId" value={postId} />
          <label className="block">
            <SectionLabel>Publish at</SectionLabel>
            <input
              name="scheduledFor"
              type="datetime-local"
              defaultValue={defaultScheduledFor}
              className="mt-1 h-8 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink"
            />
          </label>
          <SubmitButton pendingLabel="Approving…">
            <CheckCircle2 />
            Approve &amp; schedule
          </SubmitButton>
          <Link
            href={`/content/${assetId}`}
            className="inline-flex h-8 items-center rounded-md px-3 text-[12px] font-medium text-ink-secondary transition-colors hover:bg-surface-raised hover:text-ink"
          >
            Edit copy
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="md"
            onClick={() => setRejecting(true)}
          >
            <ThumbsDown />
            Reject
          </Button>
        </ActionForm>
      )}
    </div>
  );
}
