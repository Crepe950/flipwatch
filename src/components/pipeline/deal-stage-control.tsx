"use client";

import { useOptimistic, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { moveDealStageAction } from "@/app/pipeline/actions";
import { ActionError } from "@/components/ui/action-error";
import { describeActionError, type ActionFailure } from "@/components/ui/action-failure";
import type { DealStage } from "@/lib/types";
import { StageSelect } from "./stage-select";

export function DealStageControl({ dealId, stage }: { dealId: number; stage: DealStage }) {
  const [optimisticStage, setOptimisticStage] = useOptimistic(stage);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ActionFailure | null>(null);

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-2">
        <StageSelect
          value={optimisticStage}
          disabled={pending}
          size="md"
          onChange={(next) => {
            setError(null);
            startTransition(async () => {
              setOptimisticStage(next);
              try {
                const result = await moveDealStageAction(dealId, next);
                if (!result.ok) setError({ message: result.error });
              } catch (err) {
                // The optimistic stage snaps back when the transition ends.
                setError(await describeActionError(err, "Couldn't move the deal"));
              }
            });
          }}
        />
        {pending ? <Loader2 className="size-4 animate-spin text-muted" aria-hidden /> : null}
      </div>
      <ActionError error={error} />
    </div>
  );
}
