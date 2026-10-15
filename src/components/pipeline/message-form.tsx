"use client";

import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { addDealMessageAction } from "@/app/pipeline/actions";
import { ActionError } from "@/components/ui/action-error";
import { describeActionError, type ActionFailure } from "@/components/ui/action-failure";
import { Button } from "@/components/ui/button";

const OPTIONS = [
  { value: "in", label: "Seller replied" },
  { value: "out", label: "I sent" },
  { value: "note", label: "Note" },
] as const;

export function MessageForm({ dealId }: { dealId: number }) {
  const ids = useId();
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<ActionFailure | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      try {
        const result = await addDealMessageAction(formData);
        if (result.ok) {
          const el = form.current?.elements.namedItem("body");
          if (el instanceof HTMLTextAreaElement) el.value = "";
        } else {
          setError({ message: result.error });
        }
      } catch (err) {
        // The text stays in the box so it can be sent again.
        setError(await describeActionError(err, "Couldn't add the message"));
      }
    });
  }

  return (
    <form ref={form} onSubmit={onSubmit} className="space-y-2">
      <input type="hidden" name="dealId" value={dealId} />
      <label htmlFor={`${ids}-body`} className="sr-only">
        Message
      </label>
      <textarea
        id={`${ids}-body`}
        name="body"
        rows={3}
        required
        maxLength={5000}
        placeholder="Paste the seller's reply or add a note…"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted/70 focus:outline-2 focus:outline-offset-0 focus:outline-accent"
      />
      <div className="flex items-center gap-2">
        <label htmlFor={`${ids}-direction`} className="sr-only">
          Type
        </label>
        <select
          id={`${ids}-direction`}
          name="direction"
          defaultValue="in"
          className="h-8 rounded-lg border border-border bg-surface px-2 text-xs text-fg focus:outline-2 focus:outline-offset-0 focus:outline-accent"
        >
          {OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={pending} className="ml-auto">
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
          Add to log
        </Button>
      </div>
      <ActionError error={error} />
    </form>
  );
}
