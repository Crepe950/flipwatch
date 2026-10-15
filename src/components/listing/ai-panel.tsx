import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, KeyRound, MessageCircleQuestion, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DealScore } from "@/components/ui/deal-score";
import { TimeAgo } from "@/components/ui/time-ago";
import type { AiStatus } from "@/lib/ai";
import type { AiEvaluation } from "@/lib/db/schema";
import { formatPrice } from "@/lib/format";
import { AiRunButton } from "./ai-run-button";
import { AiVerdictBadge } from "./ai-verdict-badge";

function Points({ title, items, icon, className }: { title: string; items: unknown; icon: ReactNode; className?: string }) {
  // jsonb columns: don't trust the shape.
  const list = Array.isArray(items) ? items.filter((i): i is string => typeof i === "string" && i.trim() !== "") : [];
  if (list.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      <ul className="space-y-1.5 text-sm">
        {list.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span className={className} aria-hidden>
              {icon}
            </span>
            <span className="min-w-0 break-words">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function resaleRange(e: AiEvaluation, currency: string): string {
  const { estimatedResaleLowCents: low, estimatedResaleHighCents: high } = e;
  if (low === null && high === null) return "—";
  if (low === null || high === null || low === high) return formatPrice(low ?? high, currency);
  return `${formatPrice(low, currency)} – ${formatPrice(high, currency)}`;
}

export function AiPanel({
  listingId,
  status,
  evaluation,
  currency,
}: {
  listingId: number;
  status: AiStatus;
  evaluation: AiEvaluation | null;
  currency: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Sparkles className="size-4 text-accent" aria-hidden />
          AI deal analysis
        </CardTitle>
        {evaluation ? <AiVerdictBadge verdict={evaluation.verdict} /> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {evaluation ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <DealScore score={evaluation.dealScore} title="AI deal score" />
              <span>
                {evaluation.model} · <TimeAgo date={evaluation.createdAt} />
              </span>
            </div>
            <p className="text-sm leading-relaxed break-words whitespace-pre-line">{evaluation.summary}</p>
            <dl className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <dt className="text-xs text-muted">Resale range</dt>
                <dd className="text-sm font-semibold">{resaleRange(evaluation, currency)}</dd>
              </div>
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <dt className="text-xs text-muted">Suggested offer</dt>
                <dd className="text-sm font-semibold">
                  {evaluation.suggestedOfferCents === null ? "—" : formatPrice(evaluation.suggestedOfferCents, currency)}
                </dd>
              </div>
            </dl>
            <Points title="Why" items={evaluation.reasons} icon={<CheckCircle2 className="mt-0.5 size-4" />} className="text-accent" />
            <Points title="Red flags" items={evaluation.redFlags} icon={<AlertTriangle className="mt-0.5 size-4" />} className="text-danger" />
            <Points
              title="Ask the seller"
              items={evaluation.questionsForSeller}
              icon={<MessageCircleQuestion className="mt-0.5 size-4" />}
              className="text-info"
            />
          </>
        ) : status.configured ? (
          <p className="text-sm text-muted">
            Get the AI&apos;s take on this listing: a resale range, a fair offer, red flags and questions to ask the seller.
          </p>
        ) : null}

        {!status.configured ? (
          <div className="flex gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted">
            <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              AI analysis is off. Choose an AI engine in{" "}
              <Link href="/settings#ai" className="font-medium text-accent hover:underline">
                Settings → AI engine
              </Link>{" "}
              to enable it.
            </p>
          </div>
        ) : null}

        <AiRunButton listingId={listingId} configured={status.configured} rerun={evaluation !== null} />
      </CardContent>
    </Card>
  );
}
