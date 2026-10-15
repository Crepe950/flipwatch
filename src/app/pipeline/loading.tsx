export default function PipelineLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading pipeline…</span>
      <div className="mb-5 space-y-2">
        <div className="h-6 w-32 rounded-md bg-surface-2" />
        <div className="h-4 w-72 max-w-full rounded-md bg-surface-2" />
      </div>
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-[74px] rounded-xl border border-border bg-surface" />
        ))}
      </div>
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-80 w-72 shrink-0 rounded-xl bg-surface-2/60" />
        ))}
      </div>
    </div>
  );
}
