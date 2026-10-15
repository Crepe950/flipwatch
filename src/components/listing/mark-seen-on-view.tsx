"use client";

import { startTransition, useEffect } from "react";
import { markListingSeenAction } from "@/components/feed/actions";

/** Opening a listing's detail page counts as seeing its matches (like opening an email). */
export function MarkSeenOnView({ listingId, hasUnseen }: { listingId: number; hasUnseen: boolean }) {
  useEffect(() => {
    if (!hasUnseen) return;
    startTransition(async () => {
      try {
        await markListingSeenAction(listingId);
      } catch {
        // Best effort: offline or signed out, the matches simply stay unseen.
      }
    });
  }, [listingId, hasUnseen]);
  return null;
}
