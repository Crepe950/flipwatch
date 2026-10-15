/** Settings skeleton: header, section links and section cards. */
export default function SettingsLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading settings…</span>
      <div className="mb-5 space-y-2">
        <div className="h-6 w-28 rounded-md bg-surface-2" />
        <div className="h-4 w-72 max-w-full rounded-md bg-surface-2" />
      </div>
      <div className="mb-4 flex gap-2 overflow-hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-8 w-24 shrink-0 rounded-full bg-surface-2" />
        ))}
      </div>
      <div className="space-y-5">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-border bg-surface p-4">
            <div className="h-4 w-44 rounded bg-surface-2" />
            <div className="h-3 w-80 max-w-full rounded bg-surface-2" />
            <div className="h-16 rounded-lg bg-surface-2/60" />
          </div>
        ))}
      </div>
    </div>
  );
}
