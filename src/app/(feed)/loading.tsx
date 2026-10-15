/** Feed skeleton (header, the stats strip, filters and deal cards) while the feed streams in. */
export default function FeedLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading deals…</span>
      <div className="mb-5 space-y-2">
        <div className="h-6 w-40 rounded-md bg-surface-2" />
        <div className="h-4 w-64 max-w-full rounded-md bg-surface-2" />
      </div>
      <div className="mb-4 flex gap-2 overflow-hidden md:grid md:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-[70px] min-w-32 shrink-0 rounded-xl border border-border bg-surface md:min-w-0" />
        ))}
      </div>
      <div className="mb-4 h-10 rounded-lg bg-surface-2" />
      <div className="grid gap-3 xl:grid-cols-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex gap-3 rounded-xl border border-border bg-surface p-3">
            <div className="size-24 shrink-0 rounded-lg bg-surface-2 sm:size-28" />
            <div className="flex-1 space-y-2 py-1">
              <div className="h-3 w-24 rounded bg-surface-2" />
              <div className="h-4 w-full rounded bg-surface-2" />
              <div className="h-4 w-2/3 rounded bg-surface-2" />
              <div className="h-5 w-20 rounded bg-surface-2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
