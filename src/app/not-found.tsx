import { LogoMark } from "@/components/shell/logo";
import { LinkButton } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-6">
      <div className="w-full max-w-md text-center">
        <LogoMark className="mx-auto size-12" />
        <p className="mt-6 text-[13px] tracking-[0.2em] text-ink-faint">404</p>
        <h1 className="mt-2 text-[24px] font-semibold text-ink">That screen does not exist</h1>
        <p className="mt-2 text-[13.5px] text-ink-muted">
          The link may be from an older build, or the route has not been implemented yet.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <LinkButton href="/dashboard" variant="primary">
            Go to dashboard
          </LinkButton>
          <LinkButton href="/content" variant="secondary">
            Content queue
          </LinkButton>
        </div>
      </div>
    </div>
  );
}
