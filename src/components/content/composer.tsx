"use client";

import { useState } from "react";
import { CalendarClock, Send } from "lucide-react";
import { createPostAction } from "@/app/actions/posts";
import { ActionForm } from "@/components/ui/action-form";
import { SubmitButton } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/ops-primitives";
import { platformLabel } from "@/components/ui/status";
import type { Platform } from "@/generated/prisma/enums";

/**
 * Builds one post: which copy variant, which accounts, and when.
 *
 * Accounts that cannot accept this media are disabled with the platform's own
 * reason attached, so the rejection is explained here rather than at publish time.
 */

export type ComposerVariant = {
  id: string;
  label: string;
  hook: string;
  isControl: boolean;
};

export type ComposerAccount = {
  id: string;
  platform: Platform;
  handle: string;
  connected: boolean;
  blockedReason: string | null;
  warnings: string[];
};

export function Composer({
  projectId,
  assetId,
  variants,
  accounts,
  policyNote,
  defaultScheduledFor,
}: {
  projectId: string;
  assetId: string;
  variants: ComposerVariant[];
  accounts: ComposerAccount[];
  policyNote: string;
  defaultScheduledFor: string;
}) {
  const [variantId, setVariantId] = useState(
    variants.find((variant) => variant.isControl)?.id ?? variants[0]?.id ?? "",
  );
  const [selected, setSelected] = useState<string[]>(
    accounts.filter((account) => !account.blockedReason).map((account) => account.id),
  );

  const eligible = accounts.filter((account) => !account.blockedReason);
  const activeWarnings = accounts
    .filter((account) => selected.includes(account.id))
    .flatMap((account) => account.warnings);

  if (variants.length === 0) {
    return (
      <p className="px-4 py-6 text-[11.5px] leading-relaxed text-ink-muted">
        No copy variants yet. Run the analysis or write one by hand, then this asset
        can be scheduled.
      </p>
    );
  }

  return (
    <ActionForm action={createPostAction} className="space-y-4 px-4 py-4">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="variantId" value={variantId} />

      <div>
        <SectionLabel>Copy variant</SectionLabel>
        <div className="mt-1.5 space-y-1">
          {variants.map((variant) => (
            <label
              key={variant.id}
              className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors ${
                variantId === variant.id
                  ? "border-accent/50 bg-accent/8"
                  : "border-hairline bg-surface hover:bg-surface-raised"
              }`}
            >
              <input
                type="radio"
                name="variantChoice"
                value={variant.id}
                checked={variantId === variant.id}
                onChange={() => setVariantId(variant.id)}
                className="mt-1 accent-accent"
              />
              <span className="min-w-0">
                <span className="block text-[12.5px] leading-snug text-ink">
                  {variant.hook}
                </span>
                <span className="mt-0.5 block text-[10.5px] text-ink-muted">
                  {variant.label}
                  {variant.isControl ? " · control" : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Destinations</SectionLabel>
        {accounts.length === 0 ? (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-muted">
            This project has no social accounts yet. Add one on the Accounts page.
          </p>
        ) : (
          <div className="mt-1.5 space-y-1">
            {accounts.map((account) => {
              const blocked = Boolean(account.blockedReason);
              return (
                <label
                  key={account.id}
                  className={`flex items-start gap-2.5 rounded-md border px-2.5 py-2 ${
                    blocked
                      ? "cursor-not-allowed border-hairline bg-surface/50 opacity-70"
                      : "cursor-pointer border-hairline bg-surface hover:bg-surface-raised"
                  }`}
                >
                  <input
                    type="checkbox"
                    name="socialAccountIds"
                    value={account.id}
                    disabled={blocked}
                    checked={selected.includes(account.id)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...current, account.id]
                          : current.filter((id) => id !== account.id),
                      )
                    }
                    className="mt-0.5 accent-accent"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] text-ink">
                      {platformLabel(account.platform)}{" "}
                      <span className="text-ink-muted">{account.handle}</span>
                    </span>
                    {account.blockedReason ? (
                      <span className="mt-0.5 block text-[10.5px] leading-relaxed text-[#ec7d7d]">
                        {account.blockedReason}
                      </span>
                    ) : !account.connected ? (
                      <span className="mt-0.5 block text-[10.5px] leading-relaxed text-ink-muted">
                        Not connected — fine in simulation mode, needs a session for
                        live publishing.
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <label htmlFor="scheduledFor" className="block">
          <SectionLabel>Publish at</SectionLabel>
        </label>
        <div className="mt-1.5 flex items-center gap-2">
          <CalendarClock className="size-3.5 shrink-0 text-ink-muted" />
          <input
            id="scheduledFor"
            name="scheduledFor"
            type="datetime-local"
            defaultValue={defaultScheduledFor}
            className="h-8 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-ink"
          />
        </div>
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-muted">
          Your local time. Leave it as-is to schedule; clear it to keep the post as
          a draft awaiting a time.
        </p>
      </div>

      {activeWarnings.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-warning/30 bg-warning/8 px-2.5 py-2">
          {activeWarnings.map((warning, index) => (
            <li key={index} className="text-[10.5px] leading-relaxed text-[#f6c455]">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2.5 border-t border-hairline pt-3">
        <SubmitButton
          disabled={selected.length === 0 || eligible.length === 0}
          pendingLabel="Creating…"
        >
          <Send />
          Create post
        </SubmitButton>
        <span className="text-[10.5px] leading-relaxed text-ink-muted">
          {policyNote}
        </span>
      </div>
    </ActionForm>
  );
}
