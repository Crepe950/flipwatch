"use client";

import Link from "next/link";
import { Hourglass } from "lucide-react";
import { ListingPhoto } from "@/components/listing/listing-photo";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { formatRoi } from "@/lib/deals";
import { formatPrice, formatSignedPrice } from "@/lib/format";
import type { DealStage } from "@/lib/types";
import type { PipelineCardData } from "./card-data";
import { FollowUpBadge } from "./follow-up-badge";
import { StageSelect } from "./stage-select";

function Money({ label, cents, currency }: { label: string; cents: number | null; currency: string }) {
  if (cents === null) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="truncate text-xs font-medium tabular-nums">{formatPrice(cents, currency)}</dd>
    </div>
  );
}

export function DealCard({ card, onMove, pending }: { card: PipelineCardData; onMove: (stage: DealStage) => void; pending?: boolean }) {
  const hasMoney = card.offerCents !== null || card.purchaseCents !== null || card.salePriceCents !== null;
  return (
    <article className={cn("space-y-2.5 rounded-xl border border-border bg-surface p-3 transition-opacity", pending && "opacity-60")}>
      <div className="flex gap-3">
        <Link href={`/pipeline/${card.id}`} tabIndex={-1} aria-hidden className="shrink-0">
          <ListingPhoto src={card.imageUrl} className="size-14 rounded-lg" iconClassName="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <Link href={`/pipeline/${card.id}`} className="line-clamp-2 text-sm leading-snug font-medium break-words hover:underline">
            {card.title}
          </Link>
          <p className="mt-0.5 text-xs text-muted">
            Asking {card.askingCents === null ? "—" : formatPrice(card.askingCents, card.currency)}
            {card.listingStatus === "gone" ? " · gone" : ""}
          </p>
        </div>
      </div>

      {hasMoney ? (
        <dl className="grid grid-cols-3 gap-2">
          <Money label="Offer" cents={card.offerCents} currency={card.currency} />
          <Money label="Paid" cents={card.purchaseCents} currency={card.currency} />
          <Money label="Sold" cents={card.salePriceCents} currency={card.currency} />
        </dl>
      ) : null}

      {card.profitCents !== null ? (
        <p className="text-xs">
          <span className="text-muted">{card.stage === "sold" ? "Profit " : "Projected "}</span>
          <span className={cn("font-semibold tabular-nums", card.profitCents >= 0 ? "text-accent" : "text-danger")}>
            {formatSignedPrice(card.profitCents, card.currency)}
          </span>
          {card.roi !== null ? <span className="text-muted"> · ROI {formatRoi(card.roi)}</span> : null}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {card.followUp ? <FollowUpBadge state={card.followUp.state} label={card.followUp.label} /> : null}
        <Badge className="font-normal" title="Days in this stage">
          <Hourglass className="size-3" aria-hidden />
          {card.daysInStage === 0 ? "Today" : `${card.daysInStage}d`}
        </Badge>
        <StageSelect value={card.stage} onChange={onMove} disabled={pending} className="ml-auto" label={`Stage for ${card.title}`} />
      </div>
    </article>
  );
}
