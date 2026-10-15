/** Searches list / editor skeleton: header and a stack of cards. */
export default function SearchesLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading searches…</span>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="h-6 w-32 rounded-md bg-surface-2" />
          <div className="h-4 w-72 max-w-full rounded-md bg-surface-2" />
        </div>
        <div className="h-9 w-32 shrink-0 rounded-lg bg-surface-2 max-sm:hidden" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-border bg-surface p-4">
            <div className="h-4 w-40 rounded bg-surface-2" />
            <div className="h-3 w-56 max-w-full rounded bg-surface-2" />
            <div className="flex gap-2">
              <div className="h-5 w-16 rounded bg-surface-2" />
              <div className="h-5 w-12 rounded bg-surface-2" />
              <div className="h-5 w-28 rounded bg-surface-2" />
            </div>
            <div className="h-8 border-t border-border pt-3" />
          </div>
        ))}
      </div>
    </div>
  );
}
