"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { KanbanSquare, Loader2, Plus } from "lucide-react";
import { addToPipelineAction } from "@/components/feed/actions";
import { ActionError } from "@/components/ui/action-error";
import { describeActionError, type ActionFailure } from "@/components/ui/action-failure";
import { Button, buttonClasses } from "@/components/ui/button";
import { DEAL_STAGE_LABELS, type DealStage } from "@/lib/types";

/** "Add to pipeline" (idempotent) or, once added, a link to the deal. */
export function PipelineButton({ listingId, deal }: { listingId: number; deal: { id: number; stage: DealStage } | null }) {
  const [pending, startTransition] = useTransition();
  const [added, setAdded] = useState<{ id: number; stage: DealStage } | null>(null);
  const [error, setError] = useState<ActionFailure | null>(null);
  const current = deal ?? added;

  if (current) {
    return (
      <Link href={`/pipeline/${current.id}`} className={buttonClasses("secondary", "md")}>
        <KanbanSquare className="size-4" aria-hidden />
        In pipeline · {DEAL_STAGE_LABELS[current.stage]}
      </Link>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              const result = await addToPipelineAction(listingId);
              if (result.ok) setAdded({ id: result.dealId, stage: result.stage });
              else setError({ message: result.error });
            } catch (err) {
              setError(await describeActionError(err, "Couldn't add the listing to your pipeline"));
            }
          });
        }}
      >
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
        Add to pipeline
      </Button>
      <ActionError error={error} />
    </div>
  );
}
