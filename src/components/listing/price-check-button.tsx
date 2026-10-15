"use client";

import { useActionState } from "react";
import { Loader2, Scale } from "lucide-react";
import { runPriceCheckAction, type AiRunState } from "@/app/listings/[id]/actions";
import { ActionError } from "@/components/ui/action-error";
import { catchActionFailure } from "@/components/ui/action-failure";
import { Button } from "@/components/ui/button";

const runPriceCheck = catchActionFailure(
  runPriceCheckAction,
  "Couldn't run the price check",
  (failure): AiRunState => ({ status: "error", error: failure.message, signInHref: failure.signInHref }),
);

export function PriceCheckButton({ listingId, configured, rerun }: { listingId: number; configured: boolean; rerun: boolean }) {
  const [state, formAction, pending] = useActionState<AiRunState, FormData>(runPriceCheck, { status: "idle" });
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="listingId" value={listingId} />
      <Button type="submit" variant={rerun ? "secondary" : "primary"} size="sm" disabled={!configured || pending} className="w-full">
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Scale className="size-4" aria-hidden />}
        {pending ? "Searching marketplaces… (1–2 min)" : rerun ? "Re-check market price" : "Check market price"}
      </Button>
      {state.status === "error" && !pending ? (
        <ActionError
          error={{ message: state.error ?? "", signInHref: state.signInHref }}
          className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger"
        />
      ) : null}
    </form>
  );
}
