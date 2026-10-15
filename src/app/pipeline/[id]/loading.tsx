export default function DealLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse space-y-4">
      <span className="sr-only">Loading deal…</span>
      <div className="h-4 w-20 rounded bg-surface-2" />
      <div className="flex gap-4">
        <div className="size-24 shrink-0 rounded-xl bg-surface-2 sm:size-28" />
        <div className="flex-1 space-y-2">
          <div className="h-5 w-24 rounded bg-surface-2" />
          <div className="h-6 w-3/4 rounded bg-surface-2" />
          <div className="h-4 w-1/2 rounded bg-surface-2" />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="h-80 rounded-xl border border-border bg-surface" />
        <div className="h-80 rounded-xl border border-border bg-surface" />
      </div>
    </div>
  );
}
