"use client";

import { useRef, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/app/actions/posts";

/**
 * A form bound to a server action that returns an `ActionResult`.
 *
 * Wrapping it here means every mutation in the console reports its outcome the
 * same way — a toast carrying the server's own message, success or failure —
 * instead of each page inventing its own error handling.
 */
export function ActionForm({
  action,
  children,
  className,
  confirm,
  resetOnSuccess = false,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  className?: string;
  /** When set, the browser asks before submitting. Used for destructive things. */
  confirm?: string;
  resetOnSuccess?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      className={cn(className, pending && "pointer-events-none opacity-70")}
      onSubmit={(event) => {
        event.preventDefault();
        if (confirm && !window.confirm(confirm)) return;

        const formData = new FormData(event.currentTarget);
        startTransition(async () => {
          const result = await action(formData);
          if (result.ok) {
            toast.success(result.message);
            if (resetOnSuccess) formRef.current?.reset();
          } else {
            toast.error(result.message, { duration: 8000 });
          }
        });
      }}
    >
      {children}
    </form>
  );
}
