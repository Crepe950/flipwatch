/** Serializable view model for pipeline cards, computed on the server (where "now" is known). */
import { daysInStage, dealProfitCents, dealRoi, followUpState, formatFollowUpDate, type FollowUpState, type SummaryDeal } from "@/lib/deals";
import type { PipelineDeal } from "@/lib/queries/deals";
import type { DealStage, MarketplaceId } from "@/lib/types";

export interface PipelineCardData {
  id: number;
  stage: DealStage;
  listingId: number;
  title: string;
  imageUrl: string | null;
  marketplace: MarketplaceId;
  listingStatus: "active" | "gone";
  currency: string;
  askingCents: number | null;
  offerCents: number | null;
  purchaseCents: number | null;
  salePriceCents: number | null;
  profitCents: number | null;
  roi: number | null;
  followUp: { state: FollowUpState; label: string } | null;
  daysInStage: number;
}

export function toSummaryDeal(deal: PipelineDeal): SummaryDeal {
  return { ...deal, currency: deal.listing.currency };
}

export function toPipelineCard(deal: PipelineDeal, now: Date): PipelineCardData {
  const state = followUpState(deal.followUpAt, now);
  return {
    id: deal.id,
    stage: deal.stage,
    listingId: deal.listingId,
    title: deal.listing.title,
    imageUrl: deal.listing.imageUrl,
    marketplace: deal.listing.marketplace,
    listingStatus: deal.listing.status,
    currency: deal.listing.currency,
    askingCents: deal.listing.priceCents,
    offerCents: deal.offerCents,
    purchaseCents: deal.purchaseCents,
    salePriceCents: deal.salePriceCents,
    profitCents: dealProfitCents(deal),
    roi: dealRoi(deal),
    followUp: state && deal.followUpAt ? { state, label: formatFollowUpDate(deal.followUpAt) } : null,
    daysInStage: daysInStage(deal, now),
  };
}
