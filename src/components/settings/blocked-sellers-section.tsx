"use client";

import { useTransition } from "react";
import { Ban, Loader2 } from "lucide-react";
import { unblockSellerAction } from "@/app/settings/actions";
import { MarketplaceBadge } from "@/components/ui/marketplace-badge";
import type { MarketplaceId } from "@/lib/types";
import { SettingsSection } from "./section";

export interface BlockedSellerView {
  id: number;
  marketplace: MarketplaceId;
  sellerName: string;
  createdAt: string;
}

function UnblockButton({ id }: { id: number }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => unblockSellerAction(id))}
      className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline disabled:opacity-60"
    >
      {pending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
      Unblock
    </button>
  );
}

export function BlockedSellersSection({ sellers }: { sellers: BlockedSellerView[] }) {
  return (
    <SettingsSection
      id="blocked"
      icon={Ban}
      title="Blocked sellers"
      description="Listings from these sellers are skipped by every search, hunt and alert. Block a seller from any listing's Details card. (Craigslist and Kijiji don't show sellers.)"
    >
      {sellers.length === 0 ? (
        <p className="text-sm text-muted">Nobody blocked yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {sellers.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <MarketplaceBadge marketplace={s.marketplace} />
                <span className="truncate">{s.sellerName}</span>
              </span>
              <UnblockButton id={s.id} />
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
