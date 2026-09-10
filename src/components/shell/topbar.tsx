"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, ChevronDown, Menu, Search, X } from "lucide-react";

import type { Client, Workspace } from "@/lib/social-scales/contracts";
import { cn } from "@/lib/utils";

import { LogoLockup } from "./logo";
import { SidebarNav, SidebarPromo } from "./sidebar";

export function Topbar({
  workspace,
  clients,
  approvalsCount,
}: {
  workspace: Workspace;
  clients: Client[];
  approvalsCount: number;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [activeClientId, setActiveClientId] = React.useState(clients[0]?.id ?? "");
  const searchRef = React.useRef<HTMLInputElement>(null);

  const activeClient = clients.find((c) => c.id === activeClientId) ?? clients[0];

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setMenuOpen(false);
        setSwitcherOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    router.push(trimmed ? `/content?search=${encodeURIComponent(trimmed)}` : "/content");
  };

  return (
    <>
      <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-hairline bg-shell/85 px-4 backdrop-blur-md md:px-6">
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
          className="rounded-md p-2 text-ink-muted hover:bg-white/6 hover:text-ink lg:hidden"
        >
          <Menu className="size-5" />
        </button>

        <div className="lg:hidden">
          <LogoLockup compact />
        </div>

        {/* Workspace / client switcher */}
        <div className="relative hidden md:block">
          <button
            type="button"
            onClick={() => setSwitcherOpen((v) => !v)}
            aria-expanded={switcherOpen}
            aria-haspopup="menu"
            className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] border border-hairline bg-surface-2/70 px-3 text-[13px] text-ink hover:border-accent/35"
          >
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            <span className="max-w-[150px] truncate">{activeClient?.name ?? workspace.name}</span>
            <ChevronDown className="size-3.5 text-ink-faint" />
          </button>

          {switcherOpen ? (
            <div
              role="menu"
              className="absolute top-11 left-0 z-40 w-[264px] rounded-[var(--radius-card)] border border-hairline-strong bg-surface p-1.5 shadow-[0_24px_48px_-24px_rgba(0,0,0,0.9)]"
            >
              <p className="ss-eyebrow px-2.5 py-1.5">Switch client</p>
              {clients.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActiveClientId(client.id);
                    setSwitcherOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                    client.id === activeClientId ? "bg-accent/10 text-accent" : "text-ink-muted hover:bg-white/5 hover:text-ink",
                  )}
                >
                  <span className="truncate">{client.name}</span>
                  <span className="text-[11px] text-ink-faint">{client.niche}</span>
                </button>
              ))}
              <div className="mt-1 border-t border-hairline pt-1">
                <Link
                  href="/clients"
                  onClick={() => setSwitcherOpen(false)}
                  className="block rounded-md px-2.5 py-2 text-[13px] text-ink-muted hover:bg-white/5 hover:text-ink"
                >
                  Manage all clients
                </Link>
              </div>
            </div>
          ) : null}
        </div>

        {/* Global search — hidden on phones, where the bar has no room for it. */}
        <form onSubmit={submitSearch} className="relative hidden min-w-0 flex-1 sm:block md:max-w-[420px]">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search content, clients, ideas..."
            aria-label="Search content"
            className="h-9 w-full rounded-[var(--radius-control)] border border-hairline bg-surface-2/70 pr-14 pl-9 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent/50"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border border-hairline bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-faint sm:block">
            ⌘K
          </kbd>
        </form>

        <div className="ml-auto flex items-center gap-1.5">
          {/* Phone-sized stand-in for the search field above. */}
          <Link
            href="/content"
            aria-label="Search content"
            className="rounded-md p-2 text-ink-muted transition-colors hover:bg-white/6 hover:text-ink sm:hidden"
          >
            <Search className="size-[18px]" />
          </Link>

          <Link
            href="/content?status=NEEDS_REVIEW"
            aria-label={`${approvalsCount} items awaiting approval`}
            className="relative rounded-md p-2 text-ink-muted transition-colors hover:bg-white/6 hover:text-ink"
          >
            <Bell className="size-[18px]" />
            {approvalsCount > 0 ? (
              <span className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-[#04121a]">
                {approvalsCount}
              </span>
            ) : null}
          </Link>

          <div className="ml-1 h-6 w-px bg-hairline" aria-hidden />

          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              className="flex items-center gap-2.5 rounded-[var(--radius-control)] py-1.5 pr-2 pl-1.5 hover:bg-white/5"
            >
              <span className="inline-flex size-8 items-center justify-center rounded-full border border-accent/25 bg-accent/10 text-[11px] font-semibold text-accent">
                {workspace.ownerName
                  .split(" ")
                  .map((n) => n[0])
                  .join("")}
              </span>
              <span className="hidden text-left sm:block">
                <span className="block text-[13px] leading-tight font-medium text-ink">{workspace.ownerName}</span>
                <span className="block text-[11px] leading-tight text-ink-faint">{workspace.ownerRole}</span>
              </span>
              <ChevronDown className="size-3.5 text-ink-faint" />
            </button>

            {menuOpen ? (
              <div
                role="menu"
                className="absolute top-12 right-0 z-40 w-[220px] rounded-[var(--radius-card)] border border-hairline-strong bg-surface p-1.5 shadow-[0_24px_48px_-24px_rgba(0,0,0,0.9)]"
              >
                <div className="px-2.5 py-2">
                  <p className="text-[13px] font-medium text-ink">{workspace.name}</p>
                  <p className="text-[11px] text-ink-faint">{workspace.plan} workspace</p>
                </div>
                <div className="border-t border-hairline pt-1">
                  <Link
                    href="/settings"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-md px-2.5 py-2 text-[13px] text-ink-muted hover:bg-white/5 hover:text-ink"
                  >
                    Workspace settings
                  </Link>
                  <Link
                    href="/integrations"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-md px-2.5 py-2 text-[13px] text-ink-muted hover:bg-white/5 hover:text-ink"
                  >
                    Integrations
                  </Link>
                  <span
                    className="block cursor-not-allowed rounded-md px-2.5 py-2 text-[13px] text-ink-faint"
                    title="Authentication is provided by the host application. The standalone frontend has no session to end."
                  >
                    Sign out — unavailable
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {/* Mobile navigation */}
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
            className="absolute inset-0 bg-black/70"
          />
          <div className="ss-scrollbar relative flex h-full w-[272px] flex-col justify-between overflow-y-auto border-r border-hairline-strong bg-shell px-4 py-5">
            <div>
              <div className="flex items-center justify-between">
                <LogoLockup />
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  aria-label="Close"
                  className="rounded-md p-1.5 text-ink-muted hover:bg-white/6 hover:text-ink"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="mt-6">
                <SidebarNav onNavigate={() => setMobileNavOpen(false)} />
              </div>
            </div>
            <div className="pt-6">
              <SidebarPromo />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
