"use client";

import { useEffect, useEffectEvent, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { marketplaceLabel } from "@/components/ui/marketplace-badge";
import { cn } from "@/lib/cn";
import type { FeedFilters as Filters } from "@/lib/queries/feed";
import { MARKETPLACES, type MarketplaceId, type MatchEventType } from "@/lib/types";
import { filtersToSearchParams, hasActiveFilters, typedAfterNavigation } from "./filter-params";
import { QUIET_TOOLTIP } from "./quiet";

const SCORE_OPTIONS = [40, 60, 80] as const;
const Q_DEBOUNCE_MS = 350;

const control =
  "h-8 shrink-0 rounded-lg border border-border bg-surface px-2 text-xs text-fg focus:outline-2 focus:outline-offset-0 focus:outline-accent";

function Toggle({ pressed, onClick, title, children }: { pressed: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "h-8 shrink-0 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        pressed ? "border-accent/40 bg-accent-soft text-accent" : "border-border bg-surface text-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Compact filter bar. Filters live in the URL (shareable, back-button friendly); the server page
 * re-renders the list. While that navigation is pending the list (children) is dimmed.
 */
export function FeedFilters({
  filters,
  searches,
  children,
}: {
  filters: Filters;
  searches: Array<{ id: number; name: string }>;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const urlQ = filters.q ?? "";
  // What was typed into the title search, or null while it simply shows the URL's `q`.
  const [typed, setTyped] = useState<string | null>(null);
  const [lastUrlQ, setLastUrlQ] = useState(urlQ);
  if (urlQ !== lastUrlQ) {
    // The URL changed (Back, the Feed link, a search chip… or our own debounced search landing).
    setLastUrlQ(urlQ);
    const next = typedAfterNavigation(typed, urlQ);
    if (next !== typed) setTyped(next);
  }
  const q = typed ?? urlQ;

  function navigate(next: Filters, mode: "push" | "replace" = "push") {
    const qs = filtersToSearchParams(next).toString();
    const href = qs ? `${pathname}?${qs}` : pathname;
    startTransition(() => {
      if (mode === "push") router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    });
  }

  function update(patch: Partial<Filters>) {
    navigate({ ...filters, q: q.trim() || undefined, ...patch });
  }

  // Debounced title search, only for typed text; replace() so typing doesn't flood the history.
  // While another filter change is on its way the typed text rides along with it (see update()).
  const commitTyped = useEffectEvent((text: string) => navigate({ ...filters, q: text || undefined }, "replace"));
  useEffect(() => {
    if (typed === null || isPending) return;
    const trimmed = typed.trim();
    if (trimmed === urlQ) return;
    const timer = window.setTimeout(() => commitTyped(trimmed), Q_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [typed, isPending, urlQ]);

  const active = hasActiveFilters(filters);

  return (
    <>
      <div role="search" aria-label="Filter deals" className="mb-4 space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search titles…"
            aria-label="Search listing titles"
            maxLength={100}
            enterKeyHint="search"
            className="h-10 w-full rounded-lg border border-border bg-surface pr-3 pl-9 text-sm text-fg placeholder:text-muted/70 focus:outline-2 focus:outline-offset-0 focus:outline-accent"
          />
        </div>
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
          <select
            aria-label="Search"
            className={cn(control, "max-w-44")}
            value={filters.searchId ?? ""}
            onChange={(e) => update({ searchId: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">All searches</option>
            {searches.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            {filters.searchId !== undefined && !searches.some((s) => s.id === filters.searchId) ? (
              <option value={filters.searchId}>Deleted search</option>
            ) : null}
          </select>
          <select
            aria-label="Marketplace"
            className={control}
            value={filters.marketplace ?? ""}
            onChange={(e) => update({ marketplace: (e.target.value || undefined) as MarketplaceId | undefined })}
          >
            <option value="">All marketplaces</option>
            {MARKETPLACES.map((m) => (
              <option key={m} value={m}>
                {marketplaceLabel(m)}
              </option>
            ))}
          </select>
          <select
            aria-label="Event"
            className={control}
            value={filters.event ?? ""}
            onChange={(e) => update({ event: (e.target.value || undefined) as MatchEventType | undefined })}
          >
            <option value="">New &amp; drops</option>
            <option value="new">New listings</option>
            <option value="price_drop">Price drops</option>
          </select>
          <select
            aria-label="Minimum deal score"
            className={control}
            value={filters.minScore ?? ""}
            onChange={(e) => update({ minScore: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">Any score</option>
            {SCORE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                Score {s}+
              </option>
            ))}
            {filters.minScore !== undefined && !SCORE_OPTIONS.some((s) => s === filters.minScore) ? (
              <option value={filters.minScore}>Score {filters.minScore}+</option>
            ) : null}
          </select>
          <Toggle
            pressed={filters.includeInitial}
            title={`Include quiet matches. ${QUIET_TOOLTIP}`}
            onClick={() => update({ includeInitial: !filters.includeInitial })}>
            Quiet
          </Toggle>
          <Toggle
            pressed={filters.includeDismissed}
            title="Include deals you dismissed"
            onClick={() => update({ includeDismissed: !filters.includeDismissed })}>
            Dismissed
          </Toggle>
          {active ? (
            <button
              type="button"
              onClick={() => {
                setTyped("");
                navigate({ includeInitial: true, includeDismissed: false });
              }}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-3.5" aria-hidden />
              Clear
            </button>
          ) : null}
        </div>
      </div>
      <div data-pending={isPending ? "" : undefined} className={cn("transition-opacity", isPending && "opacity-60")}>
        {children}
      </div>
    </>
  );
}
