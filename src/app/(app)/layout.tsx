import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { LogoMark } from "@/components/shell/logo";
import { getAdapter } from "@/lib/social-scales";

/**
 * The adapter holds live state (approvals, schedules, generation jobs), so
 * every app route renders per request rather than being prerendered.
 */
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const adapter = getAdapter();
  const [workspace, clients, queue] = await Promise.all([
    adapter.getWorkspace(),
    adapter.getClients(),
    adapter.getContentQueue({ status: "NEEDS_REVIEW" }),
  ]);

  return (
    <div className="flex min-h-dvh">
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar workspace={workspace} clients={clients} approvalsCount={queue.items.length} />

        <main className="ss-scrollbar min-w-0 flex-1 px-4 py-5 md:px-6 md:py-6">
          <div className="mx-auto w-full max-w-[1560px]">{children}</div>
        </main>

        <footer className="border-t border-hairline px-4 py-4 md:px-6">
          <div className="mx-auto flex w-full max-w-[1560px] flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <LogoMark className="size-6" />
              <div>
                <p className="text-[12px] font-medium text-ink">Social Scales Marketing Agency</p>
                <p className="text-[11px] text-ink-faint">Systems for a bigger tomorrow.</p>
              </div>
            </div>
            <p className="flex items-center gap-2 text-[10.5px] tracking-[0.22em] text-ink-faint">
              <span>CREATE</span>
              <span className="text-hairline-strong">/</span>
              <span>AUTOMATE</span>
              <span className="text-hairline-strong">/</span>
              <span>SCALE</span>
              <span className="ml-2 h-px w-10 bg-accent/50" aria-hidden />
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
