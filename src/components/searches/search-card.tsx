import { Fragment } from "react";
import Link from "next/link";
import { CircleAlert, Info, MapPin, Search as SearchIcon, Tag, Timer, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { MarketplaceBadge, marketplaceLabel } from "@/components/ui/marketplace-badge";
import { TimeAgo, TimeUntil } from "@/components/ui/time-ago";
import { cn } from "@/lib/cn";
import { ebayQuotaFloorSec, effectiveIntervalSec } from "@/lib/engine";
import { currencyForCountry } from "@/lib/locations";
import type { SearchWithStats } from "@/lib/queries/searches";
import { CATEGORY_LABELS } from "@/lib/types";
import { describeInterval, describePriceRange } from "./describe";
import { describeLastError, type RunIssue, type SkipReasons } from "./run-messages";
import { SearchActions, SearchEnabledSwitch } from "./search-controls";

function Stat({ value, label, highlight }: { value: number; label: string; highlight?: boolean }) {
  return (
    <span className="whitespace-nowrap">
      <span className={cn("font-semibold tabular-nums", highlight ? "text-accent" : "text-fg")}>{value.toLocaleString("en-US")}</span>{" "}
      <span className="text-muted">{label}</span>
    </span>
  );
}

function IssueText({ issue }: { issue: RunIssue }) {
  const label = issue.marketplace ? `${marketplaceLabel(issue.marketplace)}: ` : "";
  if (issue.kind === "backoff") {
    return (
      <>
        {label}
        {issue.text} — retrying <TimeUntil date={issue.until} />
      </>
    );
  }
  if (issue.kind === "skipped") return <>{`${label}skipped, ${issue.text}`}</>;
  return <>{`${label}${issue.text}`}</>;
}

/** The last run's problems: failures in red, backoffs in amber, marketplaces that were only skipped in grey. */
function LastRunIssues({ issues }: { issues: RunIssue[] }) {
  const tone = issues.some((i) => i.kind === "error") ? "error" : issues.some((i) => i.kind === "backoff") ? "backoff" : "skipped";
  const Icon = tone === "error" ? CircleAlert : tone === "backoff" ? TriangleAlert : Info;
  const heading = tone === "error" ? "Last run had errors" : tone === "backoff" ? "Backing off after failures" : "Last run skipped";
  return (
    <details
      className={cn(
        "group mt-3 rounded-lg px-3 py-2 text-sm",
        tone === "error" ? "bg-danger-soft text-danger" : tone === "backoff" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted",
      )}
    >
      <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
        <Icon className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate group-open:hidden">
          {issues.map((issue, i) => (
            <Fragment key={i}>
              {i > 0 ? "; " : null}
              <IssueText issue={issue} />
            </Fragment>
          ))}
        </span>
        <span className="hidden flex-1 font-medium group-open:inline">{heading}</span>
      </summary>
      <ul className="mt-1.5 space-y-1 pl-6 break-words">
        {issues.map((issue, i) => (
          <li key={i}>
            <IssueText issue={issue} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * `skipReasons`: marketplaces that can't run for this search's country (to tell skips from failures).
 * `ebaySearches`: enabled searches that poll eBay and share its daily quota, or null when eBay isn't set up.
 */
export function SearchCard({
  search,
  skipReasons,
  ebaySearches = null,
}: {
  search: SearchWithStats;
  skipReasons: SkipReasons;
  ebaySearches?: number | null;
}) {
  const currency = currencyForCountry(search.location.countryCode);
  const category = search.category && search.category !== "any" ? CATEGORY_LABELS[search.category] : null;
  // Marketplaces' minimum spacing and eBay's daily quota can stretch the chosen interval; show what
  // actually happens (for a paused search: once it's resumed and shares the quota too).
  const ebayQuotaSec = ebaySearches === null ? 0 : ebayQuotaFloorSec(ebaySearches + (search.enabled ? 0 : 1));
  const intervalSec = effectiveIntervalSec(search, undefined, { ebayQuotaSec });

  // Paused cards sit back on the page background rather than being faded: opacity would take their
  // text below readable contrast, and their controls stay usable.
  return (
    <li className={cn("rounded-xl border p-4", search.enabled ? "border-border bg-surface" : "border-dashed border-border bg-bg")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Link href={`/searches/${search.id}/edit`} className="truncate font-semibold hover:underline">
              {search.name}
            </Link>
            {!search.enabled ? <Badge>Paused</Badge> : null}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-muted">
            <SearchIcon className="size-3.5 shrink-0" />
            <span className="truncate">{search.query}</span>
            {category ? <span className="shrink-0">· {category}</span> : null}
          </p>
        </div>
        <div className="hidden items-center gap-4 text-sm sm:flex">
          <Stat value={search.recentMatches} label="new · 24h" highlight={search.recentMatches > 0} />
          <Stat value={search.totalMatches} label="total" />
        </div>
        <SearchEnabledSwitch id={search.id} name={search.name} enabled={search.enabled} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted">
        <span className="flex flex-wrap gap-1">
          {search.marketplaces.map((m) => (
            <MarketplaceBadge key={m} marketplace={m} />
          ))}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <MapPin className="size-3.5 shrink-0" />
          <span className="truncate">
            {search.location.label} · {search.location.radiusKm} km
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <Tag className="size-3.5 shrink-0" />
          {describePriceRange(search.minPriceCents, search.maxPriceCents, currency)}
        </span>
        <span
          className="flex items-center gap-1.5"
          title={intervalSec > search.pollIntervalSec ? `Set to ${describeInterval(search.pollIntervalSec)}, stretched by the minimum time between checks` : undefined}
        >
          <Timer className="size-3.5 shrink-0" />
          {describeInterval(intervalSec)}
        </span>
      </div>

      {search.lastError ? <LastRunIssues issues={describeLastError(search.lastError, skipReasons)} /> : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span>
            {search.lastRunAt ? (
              <>
                Last run <TimeAgo date={search.lastRunAt} />
              </>
            ) : (
              "Not run yet"
            )}
          </span>
          <span className="flex gap-3 text-sm sm:hidden">
            <Stat value={search.recentMatches} label="new · 24h" highlight={search.recentMatches > 0} />
            <Stat value={search.totalMatches} label="total" />
          </span>
        </div>
        <SearchActions id={search.id} name={search.name} />
      </div>
    </li>
  );
}
