"use client";

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { Check, Copy, ExternalLink, Loader2, MessageSquareText, Send, Sparkles, Zap } from "lucide-react";
import { draftOutreachAction, logOutreachAction } from "@/app/listings/[id]/actions";
import { ActionError } from "@/components/ui/action-error";
import { describeActionError, type ActionFailure } from "@/components/ui/action-failure";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import type { OutreachTone } from "@/lib/ai";
import { centsToDollarsInput } from "@/lib/format";
import { DEAL_STAGE_LABELS, type DealStage } from "@/lib/types";

const TONES: Array<{ value: OutreachTone; label: string }> = [
  { value: "friendly", label: "Friendly" },
  { value: "direct", label: "Direct" },
  { value: "professional", label: "Professional" },
];

/** Copied by the quick-contact button when nothing has been drafted: first to message usually wins. */
const QUICK_OPENER = "Hi! Is this still available? I can pick up today.";

/**
 * Copy synchronously, inside the tap that asked for it. Browsers (Safari on iPhone above all) only allow a
 * clipboard write while the page has focus and the tap is still being handled — not after an await, and not
 * once a new tab has opened. A throwaway text box selected the iOS way works everywhere.
 */
function copyNow(text: string): boolean {
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  // Off-screen but still selectable; 16px keeps iOS from zooming in.
  box.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px";
  document.body.appendChild(box);
  const active = document.activeElement as HTMLElement | null;
  try {
    box.focus();
    box.select();
    box.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    box.remove();
    active?.focus?.({ preventScroll: true });
  }
}

/** copyNow, then the async Clipboard API as a second try (some desktop browsers no longer allow execCommand). */
async function copyText(text: string): Promise<boolean> {
  if (copyNow(text)) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function OutreachComposer({
  listingId,
  listingUrl,
  marketplaceName,
  defaultOfferCents,
  aiConfigured,
}: {
  listingId: number;
  listingUrl: string | null;
  marketplaceName: string;
  defaultOfferCents: number | null;
  aiConfigured: boolean;
}) {
  const ids = useId();
  const [tone, setTone] = useState<OutreachTone>("friendly");
  const [offer, setOffer] = useState(centsToDollarsInput(defaultOfferCents));
  const [askQuestions, setAskQuestions] = useState(true);
  const [text, setText] = useState("");
  const [aiGenerated, setAiGenerated] = useState(false);
  const [error, setError] = useState<ActionFailure | null>(null);
  const [copied, setCopied] = useState(false);
  const [logged, setLogged] = useState<{ dealId: number; stage: DealStage } | null>(null);
  const [drafting, startDrafting] = useTransition();
  const [logging, startLogging] = useTransition();

  function draft() {
    setError(null);
    startDrafting(async () => {
      try {
        const result = await draftOutreachAction({ listingId, tone, offer, askQuestions });
        if (!result.ok) {
          setError({ message: result.error });
          return;
        }
        setText(result.message);
        setAiGenerated(result.aiGenerated);
        setLogged(null);
      } catch (err) {
        setError(await describeActionError(err, "Couldn't draft a message"));
      }
    });
  }

  async function copy() {
    const ok = await copyText(text);
    if (!ok) {
      setError({ message: "Couldn't copy automatically. Select the text and copy it manually." });
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  /**
   * One tap to contact the seller: open the listing (where the marketplace's own Message button is — on a
   * phone this opens the app) and copy the draft, or a quick opener when nothing's drafted yet. Copy first,
   * while this page still has focus, then open the window — both inside the tap.
   */
  function copyAndOpen() {
    if (!listingUrl) return;
    const message = hasText ? text : QUICK_OPENER;
    if (!hasText) setText(QUICK_OPENER);
    const ok = copyNow(message);
    // Clipboard API fallback must also start before the new tab takes focus.
    if (!ok) void navigator.clipboard?.writeText(message).then(markCopied, () => undefined);
    window.open(listingUrl, "_blank", "noopener,noreferrer");
    if (ok) markCopied();
  }

  function markCopied() {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  function logSent() {
    setError(null);
    startLogging(async () => {
      try {
        const result = await logOutreachAction({ listingId, body: text, aiGenerated });
        if (!result.ok) setError({ message: result.error });
        else setLogged({ dealId: result.dealId, stage: result.stage });
      } catch (err) {
        setError(await describeActionError(err, "Couldn't log the message"));
      }
    });
  }

  const hasText = text.trim().length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <MessageSquareText className="size-4 text-accent" aria-hidden />
          Message the seller
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tone" htmlFor={`${ids}-tone`}>
            <Select id={`${ids}-tone`} value={tone} onChange={(e) => setTone(e.target.value as OutreachTone)}>
              {TONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Offer (optional)" htmlFor={`${ids}-offer`}>
            <Input
              id={`${ids}-offer`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="e.g. 250"
              maxLength={20}
              value={offer}
              onChange={(e) => setOffer(e.target.value)}
            />
          </Field>
        </div>
        <Checkbox
          label="Ask about condition & history"
          checked={askQuestions}
          onChange={(e) => setAskQuestions(e.target.checked)}
        />
        <Button variant="secondary" onClick={draft} disabled={drafting} className="w-full">
          {drafting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
          {drafting ? "Drafting…" : aiConfigured ? "Draft with AI" : "Draft from template"}
        </Button>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${ids}-message`} className="text-sm font-medium">
              Message
            </label>
            {aiGenerated && hasText ? <span className="text-xs text-muted">AI draft · review before sending</span> : null}
          </div>
          <Textarea
            id={`${ids}-message`}
            rows={7}
            maxLength={5000}
            value={text}
            placeholder="Hi! Is this still available? I can pick up today."
            onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value.trim()) setAiGenerated(false);
            }}
          />
        </div>

        {listingUrl ? (
          <Button onClick={copyAndOpen} className="w-full">
            <Zap className="size-4" aria-hidden />
            {hasText ? `Copy message & open on ${marketplaceName}` : `Quick message: copy “still available?” & open`}
          </Button>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={copy} disabled={!hasText}>
            {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </Button>
          {listingUrl ? (
            <a
              href={listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-sm font-medium hover:bg-surface-2"
            >
              <ExternalLink className="size-4" aria-hidden />
              Open on {marketplaceName}
            </a>
          ) : null}
          <Button size="sm" onClick={logSent} disabled={!hasText || logging} className="ml-auto">
            {logging ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            Log as sent
          </Button>
        </div>

        <ActionError error={error} className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger" />
        {logged ? (
          <p role="status" className="rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent">
            Logged. This deal is now <strong>{DEAL_STAGE_LABELS[logged.stage]}</strong> in your pipeline.{" "}
            <Link href={`/pipeline/${logged.dealId}`} className="font-semibold underline">
              View deal
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
