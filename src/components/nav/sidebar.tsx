"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  ClipboardList,
  Clapperboard,
  Compass,
  Radio,
  CalendarDays,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  Lightbulb,
  ListChecks,
  Settings,
  Sparkles,
  TrendingUp,
  Users,
  Video,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The console's primary navigation. Grouped rather than one long list, because a
 * flat thirteen-item list is where internal tools start feeling like a filing
 * cabinet.
 */

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  /** Shown as a small count on the right, e.g. items awaiting approval. */
  badge?: number;
};

type NavGroup = { label: string; items: NavItem[] };

export type SidebarCounts = {
  needsApproval: number;
  queued: number;
  failed: number;
  openRecommendations: number;
};

function groups(counts: SidebarCounts): NavGroup[] {
  return [
    {
      label: "Operate",
      items: [
        { href: "/ops", label: "Overview", icon: <LayoutDashboard /> },
        { href: "/ops/projects", label: "Projects", icon: <Sparkles /> },
        { href: "/ops/strategy", label: "Strategy", icon: <Compass /> },
        { href: "/ops/plan", label: "Plan", icon: <ClipboardList /> },
        { href: "/ops/renders", label: "Renders", icon: <Clapperboard /> },
        { href: "/ops/distribution", label: "Distribution", icon: <Radio /> },
        { href: "/ops/content", label: "Content", icon: <Video /> },
        { href: "/ops/calendar", label: "Calendar", icon: <CalendarDays /> },
        {
          href: "/ops/approvals",
          label: "Approvals",
          icon: <ListChecks />,
          badge: counts.needsApproval,
        },
        {
          href: "/ops/queue",
          label: "Publish queue",
          icon: <Gauge />,
          badge: counts.failed || counts.queued,
        },
      ],
    },
    {
      label: "Learn",
      items: [
        { href: "/ops/analytics", label: "Analytics", icon: <BarChart3 /> },
        {
          href: "/ops/recommendations",
          label: "Recommendations",
          icon: <Lightbulb />,
          badge: counts.openRecommendations,
        },
        { href: "/ops/experiments", label: "Experiments", icon: <FlaskConical /> },
        { href: "/ops/trends", label: "Trends", icon: <TrendingUp /> },
      ],
    },
    {
      label: "System",
      items: [
        { href: "/ops/accounts", label: "Accounts", icon: <Users /> },
        { href: "/ops/activity", label: "Activity", icon: <Activity /> },
        { href: "/ops/settings", label: "Settings", icon: <Settings /> },
      ],
    },
  ];
}

export function Sidebar({ counts }: { counts: SidebarCounts }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="flex h-full flex-col gap-5 overflow-y-auto px-2.5 py-3"
    >
      {groups(counts).map((group) => (
        <div key={group.label}>
          <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-muted">
            {group.label}
          </p>
          <ul className="space-y-px">
            {group.items.map((item) => {
              const active =
                item.href === "/ops"
                  ? pathname === "/ops"
                  : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-2 rounded-md px-2 py-[7px]",
                      "text-[12.5px] transition-colors duration-150",
                      "[&>svg]:size-[15px] [&>svg]:shrink-0",
                      active
                        ? "bg-surface-raised text-ink"
                        : "text-ink-secondary hover:bg-surface-raised/70 hover:text-ink",
                    )}
                  >
                    <span
                      className={cn(
                        "transition-colors",
                        active ? "text-accent-ink" : "text-ink-muted group-hover:text-ink-secondary",
                      )}
                    >
                      {item.icon}
                    </span>
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge ? (
                      <span className="rounded-full bg-surface-hover px-1.5 py-px text-[10px] tabular text-ink-secondary">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
