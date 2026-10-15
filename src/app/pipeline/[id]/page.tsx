import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { ListingPhoto } from "@/components/listing/listing-photo";
import { safeHttpUrl } from "@/components/listing/safe-url";
import { DealForm } from "@/components/pipeline/deal-form";
import { DealStageControl } from "@/components/pipeline/deal-stage-control";
import { DeleteDealButton } from "@/components/pipeline/delete-deal-button";
import { FollowUpBadge } from "@/components/pipeline/follow-up-badge";
import { MessageForm } from "@/components/pipeline/message-form";
import { MessageLog } from "@/components/pipeline/message-log";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarketplaceBadge, marketplaceLabel } from "@/components/ui/marketplace-badge";
import { TimeAgo } from "@/components/ui/time-ago";
import { getDb } from "@/lib/db";
import { daysInStage, followUpState, followUpToInput, formatFollowUpDate } from "@/lib/deals";
import { centsToDollarsInput, formatPrice } from "@/lib/format";
import { getDealDetail } from "@/lib/queries/deals";

const loadDeal = cache(async (raw: string) => {
  if (!/^\d{1,9}$/.test(raw)) return null;
  return getDealDetail(await getDb(), Number(raw));
});

export async function generateMetadata({ params }: PageProps<"/pipeline/[id]">): Promise<Metadata> {
  const detail = await loadDeal((await params).id);
  if (!detail) return { title: "Deal not found" };
  const title = detail.deal.listing.title;
  return { title: `Deal · ${title.length > 50 ? `${title.slice(0, 49)}…` : title}` };
}

export default async function DealPage({ params }: PageProps<"/pipeline/[id]">) {
  const detail = await loadDeal((await params).id);
  if (!detail) notFound();

  const { deal, messages } = detail;
  const { listing } = deal;
  const now = new Date();
  const externalUrl = safeHttpUrl(listing.url);
  const followUp = followUpState(deal.followUpAt, now);
  const days = daysInStage(deal, now);

  return (
    <div className="space-y-4">
      <Link href="/pipeline" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        Pipeline
      </Link>

      <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Link href={`/listings/${listing.id}`} className="shrink-0" aria-hidden tabIndex={-1}>
          <ListingPhoto src={listing.imageUrl} className="size-24 rounded-xl sm:size-28" />
        </Link>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <MarketplaceBadge marketplace={listing.marketplace} />
            {listing.status === "gone" ? <Badge tone="red">Listing gone</Badge> : null}
            {followUp && deal.followUpAt ? <FollowUpBadge state={followUp} label={formatFollowUpDate(deal.followUpAt)} /> : null}
          </div>
          <h1 className="text-xl leading-snug font-semibold tracking-tight break-words">
            <Link href={`/listings/${listing.id}`} className="hover:underline">
              {listing.title}
            </Link>
          </h1>
          <p className="text-sm text-muted">
            Asking <span className="font-medium text-fg">{listing.priceCents === null ? "—" : formatPrice(listing.priceCents, listing.currency)}</span>
            {listing.locationText ? ` · ${listing.locationText}` : ""} · added <TimeAgo date={deal.createdAt} /> ·{" "}
            {days === 0 ? "entered this stage today" : `${days}d in this stage`}
          </p>
          <div className="flex flex-wrap items-start gap-2">
            <DealStageControl dealId={deal.id} stage={deal.stage} />
            <Link href={`/listings/${listing.id}`} className={buttonClasses("secondary", "md")}>
              Listing details
            </Link>
            {externalUrl ? (
              <a href={externalUrl} target="_blank" rel="noopener noreferrer" className={buttonClasses("secondary", "md")}>
                <ExternalLink className="size-4" aria-hidden />
                Open on {marketplaceLabel(listing.marketplace)}
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader>
            <CardTitle>Numbers & follow-up</CardTitle>
          </CardHeader>
          <CardContent>
            <DealForm
              dealId={deal.id}
              currency={listing.currency}
              initial={{
                offer: centsToDollarsInput(deal.offerCents),
                purchase: centsToDollarsInput(deal.purchaseCents),
                sale: centsToDollarsInput(deal.salePriceCents),
                fees: centsToDollarsInput(deal.feesCents),
                otherCosts: centsToDollarsInput(deal.otherCostsCents),
                followUp: followUpToInput(deal.followUpAt),
                notes: deal.notes ?? "",
              }}
            />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Messages & notes</CardTitle>
              <span className="text-xs text-muted">{messages.length}</span>
            </CardHeader>
            <CardContent className="space-y-4">
              <MessageLog messages={messages} />
              <MessageForm dealId={deal.id} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted">Not flipping this one?</p>
              <DeleteDealButton dealId={deal.id} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
