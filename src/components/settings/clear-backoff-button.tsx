"use client";

import { useState } from "react";
import { Undo2 } from "lucide-react";
import { clearBackoffAction } from "@/app/settings/actions";
import { SubmitButton } from "@/components/searches/submit-button";
import { ActionError } from "@/components/ui/action-error";
import { describeActionError, type ActionFailure } from "@/components/ui/action-failure";
import type { MarketplaceId } from "@/lib/types";

/** "Clear backoff" for one marketplace; says why when the request fails (offline, session expired). */
export function ClearBackoffButton({ marketplace }: { marketplace: MarketplaceId }) {
  const [error, setError] = useState<ActionFailure | null>(null);
  return (
    <form
      action={async () => {
        setError(null);
        try {
          await clearBackoffAction(marketplace);
        } catch (err) {
          setError(await describeActionError(err, "Couldn't clear the backoff"));
        }
      }}
      className="space-y-1"
    >
      <SubmitButton variant="secondary" size="sm" icon={<Undo2 className="size-4" />} title="Reset failures and retry on the next run">
        Clear backoff
      </SubmitButton>
      <ActionError error={error} />
    </form>
  );
}
