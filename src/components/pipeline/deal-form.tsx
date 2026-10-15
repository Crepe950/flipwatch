"use client";

import { useId, useState, useTransition, type FormEvent } from "react";
import { Check, Loader2 } from "lucide-react";
import { updateDealAction, type DealFormField, type DealFormResult } from "@/app/pipeline/actions";
import { ActionError } from "@/components/ui/action-error";
import { describeActionError, type ActionFailure } from "@/components/ui/action-failure";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { dealProfitCents, dealRoi, formatRoi, parseMoneyInput } from "@/lib/deals";
import { formatSignedPrice } from "@/lib/format";

export interface DealFormValues {
  offer: string;
  purchase: string;
  sale: string;
  fees: string;
  otherCosts: string;
  followUp: string;
  notes: string;
}

const MONEY: Array<{ name: keyof DealFormValues & DealFormField; label: string; hint?: string }> = [
  { name: "offer", label: "Offer" },
  { name: "purchase", label: "Purchase price" },
  { name: "sale", label: "Sale price" },
  { name: "fees", label: "Selling fees", hint: "Platform / payment fees" },
  { name: "otherCosts", label: "Other costs", hint: "Gas, repairs, cleaning…" },
];

function cents(value: string): number | null {
  return parseMoneyInput(value) ?? null;
}

/**
 * Deal numbers, follow-up date and notes. Submitted with onSubmit (not <form action>) so React
 * doesn't reset the fields when the server returns validation errors.
 */
export function DealForm({ dealId, initial, currency }: { dealId: number; initial: DealFormValues; currency: string }) {
  const ids = useId();
  const [values, setValues] = useState(initial);
  const [result, setResult] = useState<DealFormResult | null>(null);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [pending, startTransition] = useTransition();

  const money = {
    purchaseCents: cents(values.purchase),
    salePriceCents: cents(values.sale),
    feesCents: cents(values.fees),
    otherCostsCents: cents(values.otherCosts),
  };
  const profit = dealProfitCents(money);
  const roi = dealRoi(money);
  const errors = result && !result.ok ? (result.fieldErrors ?? {}) : {};
  // Compare parsed amounts so "1,250" vs the saved "1250" doesn't count as an unsaved change.
  const dirty = (Object.keys(values) as Array<keyof DealFormValues>).some((k) =>
    MONEY.some((m) => m.name === k) ? parseMoneyInput(values[k]) !== parseMoneyInput(initial[k]) : values[k].trim() !== initial[k].trim(),
  );

  function set(name: keyof DealFormValues, value: string) {
    setValues((v) => ({ ...v, [name]: value }));
    if (result?.ok) setResult(null);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setFailure(null);
    startTransition(async () => {
      try {
        setResult(await updateDealAction(formData));
      } catch (err) {
        // Nothing was saved; the fields keep what was typed.
        setResult(null);
        setFailure(await describeActionError(err, "Couldn't save the deal"));
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <input type="hidden" name="dealId" value={dealId} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {MONEY.map((f) => (
          <Field key={f.name} label={f.label} htmlFor={`${ids}-${f.name}`} hint={f.hint} error={errors[f.name]}>
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted">$</span>
              <Input
                id={`${ids}-${f.name}`}
                name={f.name}
                inputMode="decimal"
                autoComplete="off"
                maxLength={16}
                value={values[f.name]}
                onChange={(e) => set(f.name, e.target.value)}
                aria-invalid={errors[f.name] ? true : undefined}
                className="pl-6 tabular-nums"
              />
            </div>
          </Field>
        ))}
        <Field label="Follow up on" htmlFor={`${ids}-followUp`} error={errors.followUp}>
          <Input
            id={`${ids}-followUp`}
            name="followUp"
            type="date"
            value={values.followUp}
            onChange={(e) => set("followUp", e.target.value)}
          />
        </Field>
      </div>

      <Field label="Notes" htmlFor={`${ids}-notes`} error={errors.notes}>
        <Textarea
          id={`${ids}-notes`}
          name="notes"
          rows={4}
          maxLength={5000}
          placeholder="Pickup details, condition, what the seller said…"
          value={values.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !dirty}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Save changes
        </Button>
        <p className="text-sm" aria-live="polite">
          {profit !== null ? (
            <>
              <span className="text-muted">Profit </span>
              <span className={cn("font-semibold tabular-nums", profit >= 0 ? "text-accent" : "text-danger")}>
                {formatSignedPrice(profit, currency)}
              </span>
              {roi !== null ? <span className="text-muted"> · ROI {formatRoi(roi)}</span> : null}
            </>
          ) : (
            <span className="text-muted">Add purchase and sale prices to see profit.</span>
          )}
        </p>
        {result?.ok && !dirty ? (
          <span role="status" className="inline-flex items-center gap-1 text-sm text-accent">
            <Check className="size-4" aria-hidden />
            Saved
          </span>
        ) : null}
        {result && !result.ok ? (
          <span role="alert" className="text-sm text-danger">
            {result.error}
          </span>
        ) : null}
        <ActionError error={failure} className="text-sm text-danger" />
      </div>
    </form>
  );
}
