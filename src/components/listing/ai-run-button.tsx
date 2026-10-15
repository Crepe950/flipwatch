"use client";

import { useActionState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { runAiAnalysisAction, type AiRunState } from "@/app/listings/[id]/actions";
import { ActionError } from "@/components/ui/action-error";
import { catchActionFailure } from "@/components/ui/action-failure";
import { Button } from "@/components/ui/button";

// When the request itself fails (offline, session expired), say why instead of replacing the page.
const runAiAnalysis = catchActionFailure(
  runAiAnalysisAction,
  "Couldn't run the analysis",
  (failure): AiRunState => ({ status: "error", error: failure.message, signInHref: failure.signInHref }),
);

export function AiRunButton({ listingId, configured, rerun }: { listingId: number; configured: boolean; rerun: boolean }) {
  const [state, formAction, pending] = useActionState<AiRunState, FormData>(runAiAnalysis, { status: "idle" });
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="listingId" value={listingId} />
      <Button type="submit" variant={rerun ? "secondary" : "primary"} size="sm" disabled={!configured || pending} className="w-full">
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
        {pending ? "Analyzing… (can take ~20 s)" : rerun ? "Re-run analysis" : "Run AI analysis"}
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
