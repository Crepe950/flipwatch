import { AlertTriangle, ExternalLink, Scale } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarketplaceBadge } from "@/components/ui/marketplace-badge";
import { TimeAgo } from "@/components/ui/time-ago";
import type { PriceCheckComp, PriceEstimate, StoredPriceCheck } from "@/lib/ai";
import { ebaySoldSearchUrl } from "@/lib/ebay-sold";
import { formatPrice } from "@/lib/format";
import { PriceCheckButton } from "./price-check-button";
import { safeHttpUrl } from "./safe-url";

function range(e: PriceEstimate, currency: string): string {
  if (e.lowCents === null && e.highCents === null) return "—";
  if (e.lowCents === null || e.highCents === null || e.lowCents === e.highCents) return formatPrice(e.lowCents ?? e.highCents, currency);
  return `${formatPrice(e.lowCents, currency)} – ${formatPrice(e.highCents, currency)}`;
}

function Comps({ ids, comps, currency }: { ids: string[]; comps: Map<string, PriceCheckComp>; currency: string }) {
  const list = ids.map((id) => comps.get(id)).filter((c): c is PriceCheckComp => c !== undefined);
  if (list.length === 0) return null;
  return (
    <details className="mt-1.5 text-xs">
      <summary className="cursor-pointer text-muted hover:text-fg">
        {list.length} comparable{list.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1.5 space-y-1">
        {list.map((c) => {
          const href = safeHttpUrl(c.url);
          return (
            <li key={c.id} className="flex items-center gap-1.5">
              <MarketplaceBadge marketplace={c.marketplace} className="shrink-0" />
              <span className="shrink-0 font-semibold tabular-nums">{formatPrice(c.priceCents, currency)}</span>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:underline">
                  <span className="truncate">{c.title}</span>
                  <ExternalLink className="size-3 shrink-0" aria-hidden />
                </a>
              ) : (
                <span className="truncate">{c.title}</span>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function EstimateRow({ e, comps, currency }: { e: PriceEstimate; comps: Map<string, PriceCheckComp>; currency: string }) {
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          {e.component ? <span className="mr-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{e.component}</span> : null}
          <span className="text-sm break-words">{e.name}</span>
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums">
          {e.typicalCents === null ? "—" : formatPrice(e.typicalCents, currency)}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        Range {range(e, currency)}
        {e.note ? ` · ${e.note}` : ""}
        {e.query ? (
          <>
            {" · "}
            <a href={ebaySoldSearchUrl(e.query, currency)} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">
              eBay sold ↗
            </a>
          </>
        ) : null}
      </p>
      <Comps ids={e.compIds} comps={comps} currency={currency} />
    </li>
  );
}

export function PriceCheckPanel({ listingId, check, configured }: { listingId: number; check: StoredPriceCheck | null; configured: boolean }) {
  const r = check?.result;
  const comps = new Map((r?.comps ?? []).map((c) => [c.id, c]));
  const failed = (r?.sources ?? []).filter((s) => s.errors.length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Scale className="size-4 text-accent" aria-hidden />
          Market price
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {r ? (
          <>
            <p className="text-xs text-muted">
              {check.model} · <TimeAgo date={check.createdAt} /> ·{" "}
              {r.sources.map((s) => `${s.marketplace} ${s.results}`).join(", ")} listings searched
            </p>
            {r.summary ? <p className="text-sm leading-relaxed break-words">{r.summary}</p> : null}
            <dl className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <dt className="text-xs text-muted">Market value</dt>
                <dd className="text-sm font-semibold">
                  {r.item.typicalCents === null ? "—" : formatPrice(r.item.typicalCents, r.currency)}
                </dd>
              </div>
              <div className="rounded-lg bg-surface-2 px-3 py-2">
                <dt className="text-xs text-muted">{r.parts.length > 0 ? "Part-out total" : "Asking"}</dt>
                <dd className="text-sm font-semibold">
                  {r.parts.length > 0
                    ? r.partOutTotalCents === null
                      ? "—"
                      : formatPrice(r.partOutTotalCents, r.currency)
                    : r.askingPriceCents === null
                      ? "—"
                      : formatPrice(r.askingPriceCents, r.currency)}
                </dd>
              </div>
            </dl>
            <div>
              <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Whole item</h3>
              <ul>
                <EstimateRow e={r.item} comps={comps} currency={r.currency} />
              </ul>
            </div>
            {r.parts.length > 0 ? (
              <div>
                <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Parts</h3>
                <ul className="divide-y divide-border">
                  {r.parts.map((p) => (
                    <EstimateRow key={p.key} e={p} comps={comps} currency={r.currency} />
                  ))}
                </ul>
              </div>
            ) : null}
            {failed.length > 0 ? (
              <div className="space-y-1 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
                {failed.map((s) => (
                  <p key={s.marketplace} className="flex gap-1.5 break-words">
                    <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                    <span>
                      {s.marketplace}: {s.errors[0]}
                      {s.errors.length > 1 ? ` (+${s.errors.length - 1} more)` : ""}
                    </span>
                  </p>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted">
            Search Facebook Marketplace and Craigslist for current listings of this item — and, for a computer, each of its
            parts — and let the AI work out what it&apos;s really worth.
          </p>
        )}
        <PriceCheckButton listingId={listingId} configured={configured} rerun={r !== undefined} />
      </CardContent>
    </Card>
  );
}
