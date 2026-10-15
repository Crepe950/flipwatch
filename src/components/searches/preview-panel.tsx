"use client";

import { CircleAlert, ExternalLink, FlaskConical, ImageOff, LoaderCircle } from "lucide-react";
import type { PreviewState } from "@/app/searches/actions";
import { safeHttpUrl } from "@/components/listing/safe-url";
import { ActionError } from "@/components/ui/action-error";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { MarketplaceBadge, marketplaceLabel } from "@/components/ui/marketplace-badge";
import { TimeAgo } from "@/components/ui/time-ago";
import { formatPrice } from "@/lib/format";
import type { PreviewListingView, PreviewMarketplaceView } from "./run-views";

export const FIELD_LABELS: Record<string, string> = {
  form: "Form",
  name: "Name",
  query: "Search for",
  excludeTerms: "Exclude",
  minPrice: "Min price",
  maxPrice: "Max price",
  expectedResale: "Expected resale",
  marketplaces: "Marketplaces",
  locationPreset: "Location",
  "location.label": "Location label",
  "location.lat": "Latitude",
  "location.lng": "Longitude",
  "location.countryCode": "Country code",
  "location.postalCode": "Postal code",
  "location.craigslistSite": "Craigslist site",
  "location.facebookLocation": "Facebook location",
  "location.kijijiLocationId": "Kijiji location id",
  "location.kijijiLocationSlug": "Kijiji location slug",
  radiusKm: "Radius",
  category: "Category",
  pollIntervalSec: "Poll interval",
  maxListingAgeHours: "Max listing age",
  notifyChannelIds: "Channels",
  notifyMinDealScore: "Min deal score",
};

function ListingRow({ listing }: { listing: PreviewListingView }) {
  const href = safeHttpUrl(listing.url);
  const title = href ? (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="line-clamp-2 font-medium hover:underline">
      {listing.title}
    </a>
  ) : (
    <span className="line-clamp-2 font-medium">{listing.title}</span>
  );
  return (
    <li className="flex gap-3 py-2.5">
      <div className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-lg bg-surface-2 text-muted">
        {listing.imageUrl ? (
          // Marketplace CDNs are arbitrary hosts, so plain <img> (next/image is unoptimized here anyway).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={listing.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" />
        ) : (
          <ImageOff className="size-5" />
        )}
      </div>
      <div className="min-w-0 flex-1 text-sm">
        {title}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-muted">
          <span className="font-semibold text-fg tabular-nums">{formatPrice(listing.priceCents, listing.currency)}</span>
          {listing.locationText ? <span className="truncate">{listing.locationText}</span> : null}
          {listing.postedAt ? <TimeAgo date={listing.postedAt} /> : null}
        </p>
        <p className="mt-1">
          {listing.passesFilters ? (
            <Badge tone="green">Passes filters</Badge>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Badge tone="neutral">Filtered out</Badge>
              <span className="text-xs text-muted">{listing.rejectReason}</span>
            </span>
          )}
        </p>
      </div>
    </li>
  );
}

function MarketplaceResult({ result }: { result: PreviewMarketplaceView }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <MarketplaceBadge marketplace={result.marketplace} />
          {result.error ? (
            <span className="text-sm text-danger">Failed</span>
          ) : result.skipped ? (
            <span className="text-sm text-muted">Skipped</span>
          ) : (
            <span className="text-sm text-muted tabular-nums">
              {result.total} found · <span className="text-accent">{result.passing} pass</span> · {result.failing} filtered
            </span>
          )}
        </div>
        {result.searchUrl ? (
          <a
            href={result.searchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
          >
            Open on {marketplaceLabel(result.marketplace)}
            <ExternalLink className="size-3.5" />
          </a>
        ) : null}
      </div>
      <CardContent className="py-1">
        {result.error ? (
          <p className="flex items-start gap-2 py-2 text-sm text-danger">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{result.error}</span>
          </p>
        ) : result.skipped ? (
          <p className="py-3 text-sm break-words text-muted">Not queried — {result.skipped}.</p>
        ) : result.listings.length === 0 ? (
          <p className="py-3 text-sm text-muted">No listings returned for this query.</p>
        ) : (
          <ul className="divide-y divide-border">
            {result.listings.map((listing) => (
              <ListingRow key={listing.key} listing={listing} />
            ))}
          </ul>
        )}
        {result.total > result.listings.length ? (
          <p className="pb-2 text-xs text-muted">
            Showing the first {result.listings.length} of {result.total}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Results of "Test search", grouped by marketplace. */
export function PreviewPanel({ state, pending, marketplaceCount }: { state: PreviewState; pending: boolean; marketplaceCount: number }) {
  if (pending) {
    return (
      <div role="status" className="flex items-center gap-3 rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted">
        <LoaderCircle className="size-5 shrink-0 animate-spin text-accent" />
        <span>
          Searching {marketplaceCount} marketplace{marketplaceCount === 1 ? "" : "s"}… this can take up to a minute when a site is slow.
        </span>
      </div>
    );
  }
  if (state.status === "idle") return null;
  if (state.status === "invalid") {
    return (
      <div role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
        <p className="font-medium">Fix these before testing:</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {Object.entries(state.errors).map(([field, message]) => (
            <li key={field}>
              {FIELD_LABELS[field] ?? field}: {message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span className="break-words">Test failed: {state.error}</span>
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <ActionError error={state.failure} className="break-words" />
      </div>
    );
  }
  return (
    <section aria-label="Test results" className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted">
        <FlaskConical className="size-4" />
        <span>
          Test results · <TimeAgo date={state.ranAt} /> · nothing was saved
        </span>
      </div>
      {state.results.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
          No marketplaces were queried. Check that the selected marketplaces are available and serve this location.
        </p>
      ) : (
        state.results.map((result) => <MarketplaceResult key={result.marketplace} result={result} />)
      )}
    </section>
  );
}
