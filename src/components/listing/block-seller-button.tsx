"use client";

import { useState, useTransition } from "react";
import { Ban, Loader2 } from "lucide-react";
import { blockSellerAction } from "@/app/listings/[id]/actions";

/** Block this listing's seller everywhere (with a confirm step); shows what it did. */
export function BlockSellerButton({ listingId, sellerName, marketplaceName }: { listingId: number; sellerName: string; marketplaceName: string }) {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (result) return <span className="text-xs text-muted">{result}</span>;
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="inline-flex items-center gap-1 text-xs font-medium text-danger hover:underline">
        <Ban className="size-3.5" aria-hidden /> Block seller
      </button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2 text-xs">
      <span className="text-muted">
        Hide every {marketplaceName} listing from “{sellerName}”?
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await blockSellerAction(listingId);
            setResult(res.ok ? `Blocked${res.dismissed ? ` · ${res.dismissed} match${res.dismissed === 1 ? "" : "es"} dismissed` : ""}. Undo in Settings.` : res.error);
          })
        }
        className="inline-flex items-center gap-1 rounded-md bg-danger px-2 py-1 font-medium text-white disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null} Block
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="text-muted hover:text-fg">
        Cancel
      </button>
    </span>
  );
}
