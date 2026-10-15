/**
 * Neutral fallback for pages without a skeleton of their own (sign-in, not-found…). The feed,
 * searches, settings, pipeline and listing pages have shaped skeletons next to them.
 */
export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading…</span>
      <div className="mb-5 space-y-2">
        <div className="h-6 w-40 rounded-md bg-surface-2" />
        <div className="h-4 w-64 max-w-full rounded-md bg-surface-2" />
      </div>
      <div className="h-48 rounded-xl border border-border bg-surface" />
    </div>
  );
}
