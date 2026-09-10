import { Skeleton } from "@/components/ui/primitives";

export default function AppLoading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-[168px] w-full rounded-[var(--radius-panel)]" />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        <div className="flex flex-col gap-5 xl:col-span-8">
          <Skeleton className="h-[220px] w-full rounded-[var(--radius-panel)]" />
          <Skeleton className="h-[180px] w-full rounded-[var(--radius-panel)]" />
        </div>
        <div className="flex flex-col gap-5 xl:col-span-4">
          <Skeleton className="h-[160px] w-full rounded-[var(--radius-panel)]" />
          <Skeleton className="h-[240px] w-full rounded-[var(--radius-panel)]" />
        </div>
      </div>
    </div>
  );
}
