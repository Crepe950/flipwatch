import type { MarketplaceId } from "@/lib/types";
import { cn } from "@/lib/cn";

// Brand-tinted badges. Text colours are darkened brand colours that keep >= 4.5:1 on the tinted
// background over surface, bg and surface-2 in light mode (and the lighter ones in dark mode).
const STYLES: Record<MarketplaceId, { label: string; className: string }> = {
  craigslist: { label: "Craigslist", className: "bg-[#5a2d82]/12 text-[#6a3a9e] dark:text-[#b58ce0]" },
  kijiji: { label: "Kijiji", className: "bg-[#373373]/12 text-[#4d48a8] dark:text-[#9f9bea]" },
  ebay: { label: "eBay", className: "bg-[#0064d2]/12 text-[#0059bb] dark:text-[#6aa8ea]" },
  offerup: { label: "OfferUp", className: "bg-[#00ab80]/12 text-[#007052] dark:text-[#3fd6ac]" },
  facebook: { label: "Facebook", className: "bg-[#1877f2]/12 text-[#135fc2] dark:text-[#6fa8f5]" },
};

export function marketplaceLabel(id: MarketplaceId): string {
  return STYLES[id]?.label ?? id;
}

export function MarketplaceBadge({ marketplace, className }: { marketplace: MarketplaceId; className?: string }) {
  const s = STYLES[marketplace];
  return (
    <span className={cn("inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap", s?.className, className)}>
      {s?.label ?? marketplace}
    </span>
  );
}
