"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  CalendarDays,
  LayoutDashboard,
  Lightbulb,
  Plug,
  Settings,
  Sparkles,
  Target,
  Users,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { LogoLockup } from "./logo";

export const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/plan", label: "Plan", icon: Target },
  { href: "/studio", label: "Content Studio", icon: Sparkles },
  { href: "/content", label: "Content", icon: Lightbulb },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-[13px] transition-colors",
              active
                ? "bg-accent/10 font-medium text-ink shadow-[inset_0_0_0_1px_rgba(34,211,238,0.22)]"
                : "text-ink-muted hover:bg-white/4 hover:text-ink",
            )}
          >
            {active ? (
              <span className="absolute top-1/2 left-0 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent" aria-hidden />
            ) : null}
            <Icon className={cn("size-[18px] shrink-0", active ? "text-accent" : "text-ink-faint group-hover:text-ink-muted")} />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarPromo() {
  return (
    <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-accent/18 bg-[linear-gradient(160deg,rgba(34,211,238,0.10),rgba(10,15,24,0.9)_58%)] p-4">
      <div
        className="pointer-events-none absolute -right-8 -bottom-10 size-32 rounded-full bg-accent/10 blur-2xl"
        aria-hidden
      />
      <p className="text-[13px] leading-tight font-semibold tracking-wide text-accent">
        AI WORKS
        <br />
        SO YOU SCALE.
      </p>
      <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
        Plan it once. The system produces, schedules and learns every week.
      </p>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="ss-scrollbar hidden h-full w-[236px] shrink-0 flex-col justify-between overflow-y-auto border-r border-hairline bg-shell/70 px-4 py-5 lg:flex">
      <div>
        <Link href="/dashboard" className="block rounded-lg px-1 py-1">
          <LogoLockup />
        </Link>
        <p className="mt-4 px-1 text-[9.5px] leading-relaxed tracking-[0.2em] text-ink-faint">
          IDEAS. SYSTEMS.
          <br />
          CONTENT. CUSTOMERS.
        </p>

        <div className="mt-6">
          <SidebarNav />
        </div>
      </div>

      <div className="pt-6">
        <SidebarPromo />
      </div>
    </aside>
  );
}
