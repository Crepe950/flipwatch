import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ExternalLink, MapPin } from "lucide-react";
import { AiPanel } from "@/components/listing/ai-panel";
import { BlockSellerButton } from "@/components/listing/block-seller-button";
import { notSeenRecently } from "@/components/listing/freshness";
import { MarkSeenOnView } from "@/components/listing/mark-seen-on-view";
import { MatchedSearches } from "@/components/listing/matched-searches";
import { OutreachComposer } from "@/components/listing/outreach-composer";
import { PhotoGallery } from "@/components/listing/photo-gallery";
import { PipelineButton } from "@/components/listing/pipeline-button";
import { PriceCheckPanel } from "@/components/listing/price-check-panel";
import { PriceHistoryChart } from "@/components/listing/price-history-chart";
import { RefreshSoon } from "@/components/listing/refresh-soon";
import { safeHttpUrl } from "@/components/listing/safe-url";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarketplaceBadge, marketplaceLabel } from "@/components/ui/marketplace-badge";
import { TimeAgo } from "@/components/ui/time-ago";
import { aiStatus, getLatestPriceCheck } from "@/lib/ai";
import { getDb } from "@/lib/db";
import { withFullDescription } from "@/lib/engine/listing-details";
import { formatPrice } from "@/lib/format";
import { getListingDetail } from "@/lib/queries/listings";

function parseId(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

/** How long opening a listing waits for its description to be read from the marketplace page. */
const DESCRIPTION_WAIT_MS = 8_000;

/**
 * One DB round per request, shared by generateMetadata and the page. Search results often carry no
 * description (Facebook's never do), so a listing without one has it read from its page first.
 */
const loadListing = cache(async (raw: string) => {
  const id = parseId(raw);
  if (id === null) return null;
  const db = await getDb();
  const detail = await getListingDetail(db, id);
  if (!detail || detail.listing.description?.trim()) return detail;
  // On timeout the read carries on in the background and saves; the page refreshes itself to pick it up.
  const listing = await Promise.race([
    withFullDescription(db, detail.listing, { interactive: true }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), DESCRIPTION_WAIT_MS)),
  ]);
  return listing ? { ...detail, listing } : { ...detail, descriptionPending: true };
});

export async function generateMetadata({ params }: PageProps<"/listings/[id]">): Promise<Metadata> {
  const detail = await loadListing((await params).id);
  if (!detail) return { title: "Listing not found" };
  const { title } = detail.listing;
  return { title: title.length > 60 ? `${title.slice(0, 59)}…` : title };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2 text-sm first:pt-0 last:pb-0">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right break-words">{children}</dd>
    </div>
  );
}

export default async function ListingPage({ params }: PageProps<"/listings/[id]">) {
  const detail = await loadListing((await params).id);
  if (!detail) notFound();

  const { listing, matches, evaluation, deal } = detail;
  const externalUrl = safeHttpUrl(listing.url);
  const mpName = marketplaceLabel(listing.marketplace);
  const drop =
    listing.priceCents !== null && listing.originalPriceCents !== null && listing.originalPriceCents > listing.priceCents
      ? listing.originalPriceCents - listing.priceCents
      : null;
  const ai = aiStatus();
  const priceCheck = await getLatestPriceCheck(await getDb(), listing.id);
  const images = Array.isArray(listing.imageUrls) ? listing.imageUrls.filter((u): u is string => typeof u === "string") : [];
  const history = detail.priceHistory.map((p) => ({ t: p.observedAt.getTime(), priceCents: p.priceCents }));
  if (history.length === 0) history.push({ t: listing.firstSeenAt.getTime(), priceCents: listing.priceCents });
  // The price is only known up to the last time we saw the listing.
  const chartEnd = listing.lastSeenAt.getTime();
  const stale = listing.status === "active" && notSeenRecently(listing.lastSeenAt, new Date());

  return (
    <div className="space-y-4">
      <MarkSeenOnView listingId={listing.id} hasUnseen={matches.some((m) => !m.seen)} />
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Deals
      </Link>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[auto_1fr]">
        <div className="min-w-0 space-y-4">
          <PhotoGallery images={images} title={listing.title} />
          <header className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <MarketplaceBadge marketplace={listing.marketplace} />
              {listing.status === "gone" ? <Badge tone="red">No longer available</Badge> : null}
              {stale ? (
                <Badge title={`Missing from ${mpName} results for over a day: it may have sold or been taken down`}>Not seen recently</Badge>
              ) : null}
              {listing.condition ? <Badge>{listing.condition}</Badge> : null}
            </div>
            <h1 className="text-xl leading-snug font-semibold tracking-tight break-words sm:text-2xl">{listing.title}</h1>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-semibold tracking-tight">
                {listing.priceCents === null ? "No price" : formatPrice(listing.priceCents, listing.currency)}
              </span>
              <span className="text-sm text-muted">{listing.currency}</span>
              {drop !== null ? (
                <>
                  <s className="text-sm text-muted">{formatPrice(listing.originalPriceCents, listing.currency)}</s>
                  <Badge tone="green">
                    <ArrowDown className="size-3" aria-hidden />
                    {formatPrice(drop, listing.currency)} ({Math.round((drop / listing.originalPriceCents!) * 100)}%)
                  </Badge>
                </>
              ) : null}
            </div>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              {listing.locationText ? (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-4" aria-hidden />
                  {listing.locationText}
                </span>
              ) : null}
              <span>
                {listing.postedAt ? "Posted " : "First seen "}
                <TimeAgo date={listing.postedAt ?? listing.firstSeenAt} />
              </span>
              <span>
                Last seen in results <TimeAgo date={listing.lastSeenAt} />
              </span>
            </p>
            <div className="flex flex-wrap items-start gap-2">
              {externalUrl ? (
                <a href={externalUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "md")}>
                  <ExternalLink className="size-4" aria-hidden />
                  Open on {mpName}
                </a>
              ) : null}
              <PipelineButton listingId={listing.id} deal={deal ? { id: deal.id, stage: deal.stage } : null} />
            </div>
          </header>
        </div>

        <aside className="min-w-0 space-y-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <AiPanel listingId={listing.id} status={ai} evaluation={evaluation} currency={listing.currency} />
          <PriceCheckPanel listingId={listing.id} check={priceCheck} configured={ai.configured} />
          <OutreachComposer
            listingId={listing.id}
            listingUrl={externalUrl}
            marketplaceName={mpName}
            defaultOfferCents={evaluation?.suggestedOfferCents ?? null}
            aiConfigured={ai.configured}
          />
        </aside>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardContent>
              {listing.description?.trim() ? (
                <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{listing.description.trim()}</p>
              ) : "descriptionPending" in detail ? (
                <>
                  <p className="text-sm text-muted">Reading the description from {mpName}…</p>
                  <RefreshSoon ms={6_000} />
                </>
              ) : (
                <p className="text-sm text-muted">No description provided.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Price history</CardTitle>
            </CardHeader>
            <CardContent>
              <PriceHistoryChart points={history} endAt={chartEnd} currency={listing.currency} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Matched searches</CardTitle>
            </CardHeader>
            <CardContent>
              <MatchedSearches matches={matches} currency={listing.currency} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y divide-border">
                <Fact label="Condition">{listing.condition ?? "—"}</Fact>
                <Fact label="Seller">
                  {listing.sellerName ? (
                    <span className="flex flex-col items-end gap-1">
                      {listing.sellerName}
                      <BlockSellerButton listingId={listing.id} sellerName={listing.sellerName} marketplaceName={mpName} />
                    </span>
                  ) : (
                    "—"
                  )}
                </Fact>
                <Fact label="Location">{listing.locationText ?? "—"}</Fact>
                <Fact label="Posted">{listing.postedAt ? <TimeAgo date={listing.postedAt} /> : "—"}</Fact>
                <Fact label="First seen">
                  <TimeAgo date={listing.firstSeenAt} />
                </Fact>
                <Fact label="Last seen in results">
                  <TimeAgo date={listing.lastSeenAt} />
                </Fact>
                <Fact label="Status">{listing.status === "gone" ? "Gone (removed or sold)" : "Active"}</Fact>
                <Fact label="Listing ID">
                  <span className="font-mono text-xs">{listing.externalId}</span>
                </Fact>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
