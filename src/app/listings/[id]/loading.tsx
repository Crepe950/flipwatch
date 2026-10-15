export default function ListingLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse space-y-4">
      <span className="sr-only">Loading listing…</span>
      <div className="h-4 w-16 rounded bg-surface-2" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="aspect-[4/3] w-full rounded-xl bg-surface-2 sm:aspect-[16/9]" />
          <div className="h-5 w-24 rounded bg-surface-2" />
          <div className="h-7 w-3/4 rounded bg-surface-2" />
          <div className="h-9 w-32 rounded bg-surface-2" />
        </div>
        <div className="space-y-4">
          <div className="h-56 rounded-xl border border-border bg-surface" />
          <div className="h-72 rounded-xl border border-border bg-surface" />
        </div>
      </div>
    </div>
  );
}
