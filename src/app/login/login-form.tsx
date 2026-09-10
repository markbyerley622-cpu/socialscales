"use client";

import { useActionState } from "react";
import { AlertTriangle } from "lucide-react";
import { loginAction, type LoginState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/ui/button";

const INITIAL: LoginState = { error: null };

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState(loginAction, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <Field label="Email" htmlFor="email">
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          className="h-9 w-full rounded-md border border-hairline-strong bg-surface px-2.5 text-[12.5px] text-ink placeholder:text-ink-muted"
          placeholder="operator@contentos.local"
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-9 w-full rounded-md border border-hairline-strong bg-surface px-2.5 text-[12.5px] text-ink"
        />
      </Field>

      {state.error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-critical/40 bg-critical/10 px-2.5 py-2 text-[11.5px] leading-relaxed text-[#ec7d7d]"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {state.error}
        </p>
      ) : null}

      <SubmitButton className="w-full" pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
