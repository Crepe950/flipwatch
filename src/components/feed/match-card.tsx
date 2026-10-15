"use client";

import Link from "next/link";
import { ArrowDown, Check, Eye, ExternalLink, KanbanSquare, MapPin, Plus, RotateCcw, TrendingDown, X } from "lucide-react";
import { AiVerdictBadge } from "@/components/listing/ai-verdict-badge";
import { notSeenRecently } from "@/components/listing/freshness";
import { ListingPhoto } from "@/components/listing/listing-photo";
import { safeHttpUrl } from "@/components/listing/safe-url";
import { Badge } from "@/components/ui/badge";
import { MarketplaceBadge, marketplaceLabel } from "@/components/ui/marketplace-badge";
import { TimeAgo, useNow } from "@/components/ui/time-ago";
import { cn } from "@/lib/cn";
import { formatPrice, formatSignedPrice, timeAgo } from "@/lib/format";
import type { FeedItem } from "@/lib/queries/feed";
import { QUIET_TOOLTIP } from "./quiet";
import { ScoreWithReason } from "./score-with-reason";

export interface MatchCardHandlers {
  onDismiss: (item: FeedItem) => void;
  onRestore: (item: FeedItem) => void;
  onSeen: (item: FeedItem) => void;
  onAddToPipeline: (item: FeedItem) => void;
}

// Local action-bar styles: combining buttonClasses("ghost") with another text colour would make the
// winner depend on CSS source order.
const action =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm font-medium whitespace-nowrap transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50";
const muted = "text-muted hover:text-fg";

export function priceDropCents(item: Pick<FeedItem, "priceCents" | "originalPriceCents">): number | null {
  const { priceCents, originalPriceCents } = item;
  if (priceCents === null || originalPriceCents === null || originalPriceCents <= priceCents) return null;
  return originalPriceCents - priceCents;
}

export function MatchCard({ item, busy, ...handlers }: { item: FeedItem; busy?: boolean } & MatchCardHandlers) {
  const href = `/listings/${item.listingId}`;
  const externalUrl = safeHttpUrl(item.url);
  const drop = priceDropCents(item);
  // Silent first-run matches never alerted, so they are not highlighted as unseen.
  const unseen = !item.seen && !item.dismissed && !item.silent;
  const titleId = `match-${item.matchId}-title`;
  const mp = marketplaceLabel(item.marketplace);
  const now = useNow();
  const stale = now !== null && item.listingStatus === "active" && notSeenRecently(item.lastSeenAt, now);

  return (
    <article
      aria-labelledby={titleId}
      className={cn(
        "relative flex flex-col rounded-xl border bg-surface transition-opacity",
        unseen ? "border-accent/40" : "border-border",
        item.dismissed && "opacity-60",
        busy && "opacity-70",
      )}
    >
      {unseen ? (
        <span aria-hidden className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-accent" />
      ) : null}

      <div className="flex gap-3 p-3">
        <Link href={href} tabIndex={-1} aria-hidden className="shrink-0">
          <ListingPhoto src={item.imageUrl} className="size-24 rounded-lg sm:size-28" />
        </Link>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <MarketplaceBadge marketplace={item.marketplace} />
            {item.lastEvent === "price_drop" ? (
              <Badge tone="blue">
                <TrendingDown className="size-3" aria-hidden />
                Price drop
              </Badge>
            ) : null}
            {item.silent ? (
              <Badge title={QUIET_TOOLTIP} className="font-normal">
                Quiet
              </Badge>
            ) : null}
            {item.listingStatus === "gone" ? <Badge tone="red">Gone</Badge> : null}
            <TimeAgo date={item.postedAt ?? item.firstSeenAt} className="ml-auto shrink-0 text-xs text-muted" />
          </div>

          <h3 id={titleId} className="mt-1 text-sm leading-snug font-medium">
            {unseen ? <span className="sr-only">Unseen: </span> : null}
            <Link href={href} className="line-clamp-2 break-words hover:underline">
              {item.title}
            </Link>
          </h3>

          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className={cn("text-lg font-semibold tracking-tight", item.priceCents === null && "text-base text-muted")}>
              {item.priceCents === null ? "No price" : formatPrice(item.priceCents, item.currency)}
            </span>
            {drop !== null ? (
              <>
                <s className="text-xs text-muted">{formatPrice(item.originalPriceCents, item.currency)}</s>
                <Badge tone="green" title="Drop since first seen">
                  <ArrowDown className="size-3" aria-hidden />
                  <span className="sr-only">Down </span>
                  {formatPrice(drop, item.currency)}
                </Badge>
              </>
            ) : null}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <ScoreWithReason score={item.dealScore} reason={item.dealScoreReason} />
            {item.estimatedProfitCents !== null ? (
              <span
                title="Estimated profit vs. the search's expected resale price"
                className={cn("font-medium tabular-nums", item.estimatedProfitCents > 0 ? "text-accent" : "text-muted")}
              >
                {formatSignedPrice(Math.round(item.estimatedProfitCents / 100) * 100, item.currency)} est.
              </span>
            ) : null}
            {item.aiVerdict ? <AiVerdictBadge verdict={item.aiVerdict} /> : null}
            {stale ? (
              <Badge
                title={`Last seen in ${mp} results ${timeAgo(item.lastSeenAt, new Date(now))}: it may have sold or been taken down`}
                className="font-normal"
              >
                Not seen recently
              </Badge>
            ) : null}
            {item.locationText ? (
              <span className="inline-flex min-w-0 items-center gap-0.5">
                <MapPin className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{item.locationText}</span>
              </span>
            ) : null}
            <Link
              href={`/?search=${item.searchId}`}
              title={`Show only “${item.searchName}” matches`}
              className="max-w-40 truncate rounded-full border border-border px-2 py-0.5 text-[11px] hover:bg-surface-2 hover:text-fg"
            >
              {item.searchName}
            </Link>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-0.5 border-t border-border px-1.5 py-1.5">
        {externalUrl ? (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => (unseen ? handlers.onSeen(item) : undefined)}
            className={cn(action, muted)}
            aria-label={`Open on ${mp} (new tab)`}
            title={`Open on ${mp}`}
          >
            <ExternalLink className="size-4" aria-hidden />
            Open
          </a>
        ) : null}
        <Link href={href} className={cn(action, muted)}>
          Details
        </Link>
        {item.dealId !== null ? (
          <Link href={`/pipeline/${item.dealId}`} className={cn(action, "text-accent")}>
            <KanbanSquare className="size-4" aria-hidden />
            <span>In pipeline</span>
          </Link>
        ) : (
          <button type="button" disabled={busy} onClick={() => handlers.onAddToPipeline(item)} className={cn(action, muted)}>
            <Plus className="size-4" aria-hidden />
            Pipeline
          </button>
        )}
        <div className="ml-auto flex items-center">
          {unseen ? (
            <button
              type="button"
              onClick={() => handlers.onSeen(item)}
              className={cn(action, muted, "px-2")}
              aria-label="Mark as seen"
              title="Mark as seen"
            >
              <Eye className="size-4" aria-hidden />
            </button>
          ) : item.dismissed ? null : (
            <span className="grid size-8 place-items-center text-muted/60" title="Seen">
              <Check className="size-4" aria-hidden />
              <span className="sr-only">Seen</span>
            </span>
          )}
          {item.dismissed ? (
            <button type="button" onClick={() => handlers.onRestore(item)} className={cn(action, muted)}>
              <RotateCcw className="size-4" aria-hidden />
              Restore
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handlers.onDismiss(item)}
              className={cn(action, "px-2 text-muted hover:text-danger")}
              aria-label="Dismiss"
              title="Dismiss"
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
