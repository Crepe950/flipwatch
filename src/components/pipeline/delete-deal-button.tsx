"use client";

import { useState, useTransition } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { deleteDealAction } from "@/app/pipeline/actions";
import { ActionError } from "@/components/ui/action-error";
import { describeActionError, type ActionFailure } from "@/components/ui/action-failure";
import { Button } from "@/components/ui/button";

export function DeleteDealButton({ dealId }: { dealId: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ActionFailure | null>(null);

  function onClick() {
    if (!window.confirm("Delete this deal and its message log? The listing stays in your feed.")) return;
    setError(null);
    startTransition(async () => {
      try {
        // On success the action redirects to /pipeline (rejecting with a redirect, which
        // describeActionError re-throws); it only returns on failure.
        const result = await deleteDealAction(dealId);
        if (result && !result.ok) setError({ message: result.error });
      } catch (err) {
        setError(await describeActionError(err, "Couldn't delete the deal"));
      }
    });
  }

  return (
    <div className="space-y-1">
      <Button variant="danger" size="sm" onClick={onClick} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
        Delete deal
      </Button>
      <ActionError error={error} />
    </div>
  );
}
