import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  // The authoritative signed-in check. The proxy cannot do this without a
  // database round trip on every request, so it lets /login through and this
  // decides. A stale-but-well-formed cookie therefore lands on a usable sign-in
  // form rather than in a redirect loop.
  if (await getCurrentUser()) redirect("/");

  const params = await props.searchParams;
  const next = typeof params.next === "string" ? params.next : undefined;

  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-[22rem]">
        <div className="mb-7">
          <div className="mb-4 flex items-center gap-2">
            <span
              aria-hidden
              className="grid size-7 place-items-center rounded-md bg-accent text-[13px] font-bold text-[#0d0b1c]"
            >
              C
            </span>
            <span className="text-[13px] font-semibold tracking-[0.16em] text-ink">
              CONTENT OS
            </span>
          </div>
          <h1 className="text-[19px] font-semibold tracking-tight text-ink">
            Sign in to the console
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
            An internal content distribution and experimentation system. Sessions
            last 14 days.
          </p>
        </div>

        <LoginForm next={next} />

        <p className="mt-6 text-[11px] leading-relaxed text-ink-muted">
          The operator account is created by the database seed. Its address and
          password are <code className="text-ink-secondary">OPERATOR_EMAIL</code>{" "}
          and <code className="text-ink-secondary">OPERATOR_PASSWORD</code> in{" "}
          <code className="text-ink-secondary">.env.local</code>.
        </p>
      </div>
    </main>
  );
}
