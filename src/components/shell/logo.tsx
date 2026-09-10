import { cn } from "@/lib/utils";

/**
 * Social Scales mark — an ascending bar chart with a rising arrow, enclosed in
 * a ring. Drawn inline so it stays crisp and inherits the accent token rather
 * than shipping a raster asset.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={cn("size-10", className)} role="img" aria-label="Social Scales">
      <circle cx="24" cy="24" r="21.5" className="fill-none stroke-accent/45" strokeWidth="1.5" />
      <circle cx="24" cy="24" r="17" className="fill-accent/6 stroke-accent/20" strokeWidth="1" />
      <g className="fill-accent">
        <rect x="14" y="27" width="3.5" height="8" rx="1.2" opacity="0.55" />
        <rect x="20" y="23" width="3.5" height="12" rx="1.2" opacity="0.75" />
        <rect x="26" y="19" width="3.5" height="16" rx="1.2" />
      </g>
      <path
        d="M14 22 L21 16 L26 20 L34 12"
        className="fill-none stroke-accent"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M28.5 12 H34 V17.5" className="fill-none stroke-accent" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function LogoLockup({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <LogoMark className={compact ? "size-8" : "size-11"} />
      <div className="min-w-0">
        <p className="text-[15px] leading-none font-semibold tracking-[0.16em] text-ink">
          SOCIAL <span className="text-accent">SCALES</span>
        </p>
        {compact ? null : (
          <p className="mt-1.5 text-[9px] leading-none tracking-[0.28em] text-ink-faint">MARKETING AGENCY</p>
        )}
      </div>
    </div>
  );
}
