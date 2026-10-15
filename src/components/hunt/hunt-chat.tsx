"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition, type FormEvent } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, MapPin, MessageSquarePlus, Search, Send, Sparkles } from "lucide-react";
import { startHuntAction } from "@/app/hunt/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DealScore } from "@/components/ui/deal-score";
import { MarketplaceBadge } from "@/components/ui/marketplace-badge";
import type { HuntPick, HuntResult } from "@/lib/ai/deal-hunt";
import { cn } from "@/lib/cn";
import { ebaySoldSearchUrl } from "@/lib/ebay-sold";
import { formatPrice } from "@/lib/format";

export interface HuntTurn {
  id: number;
  parentId: number | null;
  prompt: string;
  status: "running" | "done" | "error";
  stage: string | null;
  error: string | null;
  createdAt: string;
  result: HuntResult | null;
}

const EXAMPLES = [
  "Gaming PCs I can part out for profit under $500",
  "RTX 3080 or 3070 under $400",
  "Cheap 32GB DDR4 RAM kits",
  "PS5 disc consoles well under market price",
];

function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function PickCard({ pick }: { pick: HuntPick }) {
  const external = safeHref(pick.url);
  return (
    <li className="flex gap-3 rounded-xl border border-border bg-surface p-3">
      <div className="relative shrink-0">
        {pick.imageUrl && safeHref(pick.imageUrl) ? (
          // Marketplace CDN images: plain <img>, like the rest of the app.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pick.imageUrl} alt="" className="size-20 rounded-lg bg-surface-2 object-cover sm:size-24" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <div className="grid size-20 place-items-center rounded-lg bg-surface-2 text-muted sm:size-24">
            <Search className="size-5" />
          </div>
        )}
        <span className="absolute -top-1.5 -left-1.5 grid size-6 place-items-center rounded-full bg-accent text-xs font-bold text-accent-contrast">
          {pick.rank}
        </span>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <Link href={`/listings/${pick.listingId}`} className="line-clamp-2 text-sm font-semibold break-words hover:underline">
          {pick.title}
        </Link>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-semibold tabular-nums">{pick.priceCents === null ? "No price" : formatPrice(pick.priceCents, pick.currency)}</span>
          {pick.estimatedValueCents !== null ? (
            <span className="text-muted">worth ~{formatPrice(pick.estimatedValueCents, pick.currency)}</span>
          ) : null}
          {pick.estimatedProfitCents !== null ? (
            <span className={cn("font-medium tabular-nums", pick.estimatedProfitCents >= 0 ? "text-accent" : "text-danger")}>
              {pick.estimatedProfitCents === 0
                ? "break-even"
                : `${pick.estimatedProfitCents > 0 ? "+" : "−"}${formatPrice(Math.abs(pick.estimatedProfitCents), pick.currency)}`}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <DealScore score={pick.score} title="AI deal score for this hunt" />
          <MarketplaceBadge marketplace={pick.marketplace} />
          {pick.locationText ? <span className="text-xs text-muted">{pick.locationText}</span> : null}
        </div>
        <p className="text-xs leading-relaxed break-words text-fg/90">{pick.why}</p>
        {pick.checked ? (
          <div className="space-y-1 rounded-lg bg-accent-soft/60 px-2.5 py-2 text-xs">
            <p className="flex flex-wrap items-center gap-x-2 font-medium text-accent">
              <CheckCircle2 className="size-3.5" aria-hidden />
              Price-checked against live listings
              {pick.aiEstimateCents != null && pick.aiEstimateCents !== pick.estimatedValueCents ? (
                <span className="font-normal text-muted">(first guess ~{formatPrice(pick.aiEstimateCents, pick.currency)})</span>
              ) : null}
            </p>
            <p className="text-fg/90">
              {pick.checked.partOutTotalCents !== null ? `Parts ~${formatPrice(pick.checked.partOutTotalCents, pick.currency)}` : null}
              {pick.checked.partOutTotalCents !== null && pick.checked.itemValueCents !== null ? " · " : null}
              {pick.checked.itemValueCents !== null ? `Whole ~${formatPrice(pick.checked.itemValueCents, pick.currency)}` : null}
            </p>
            {pick.checked.parts.length ? (
              <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-muted">
                {pick.checked.parts.map((p, i) => (
                  <span key={i}>
                    {p.component} {p.typicalCents === null ? "?" : formatPrice(p.typicalCents, pick.currency)}
                    {p.query ? (
                      <a
                        href={ebaySoldSearchUrl(p.query, pick.currency)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`eBay sold listings for “${p.query}”`}
                        className="ml-0.5 text-accent hover:underline"
                      >
                        ↗
                      </a>
                    ) : null}
                  </span>
                ))}
              </p>
            ) : null}
            {pick.checked.itemQuery ? (
              <a
                href={ebaySoldSearchUrl(pick.checked.itemQuery, pick.currency)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex font-medium text-accent hover:underline"
              >
                See eBay sold prices ↗
              </a>
            ) : null}
          </div>
        ) : pick.checkError ? (
          <p className="text-xs text-muted">Price check failed ({pick.checkError}); value is the first estimate.</p>
        ) : null}
        {pick.redFlags.length ? (
          <p className="flex gap-1 text-xs break-words text-warn">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            {pick.redFlags.join(" · ")}
          </p>
        ) : null}
        {external ? (
          <a href={external} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
            Open listing <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : null}
      </div>
    </li>
  );
}

function Answer({ turn }: { turn: HuntTurn }) {
  if (turn.status === "running") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        {turn.stage ?? "Working…"}{" "}
        <span className="text-xs">(searching, then price-checking every pick — often 5–10 min; you can leave and come back)</span>
      </p>
    );
  }
  if (turn.status === "error" || !turn.result) {
    return <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{turn.error ?? "Something went wrong. Try again."}</p>;
  }
  const r = turn.result;
  const failed = r.sources.filter((s) => s.errors.length > 0);
  return (
    <div className="space-y-3">
      {r.summary ? <p className="text-sm leading-relaxed break-words">{r.summary}</p> : null}
      {r.marketNotes ? (
        <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed break-words text-muted">
          <span className="font-semibold text-fg">Market: </span>
          {r.marketNotes}
        </p>
      ) : null}
      {r.picks.length ? (
        <ol className="space-y-2">
          {r.picks.map((p) => (
            <PickCard key={p.listingId} pick={p} />
          ))}
        </ol>
      ) : null}
      <p className="text-xs text-muted">
        {r.area ? `${r.area.label} · ${r.area.radiusKm} km · ` : ""}Searched {r.queries.map((q) => `“${q}”`).join(", ")}
        {r.priceRange.minCents !== null || r.priceRange.maxCents !== null
          ? ` · ${r.priceRange.minCents !== null ? formatPrice(r.priceRange.minCents, "CAD") : "any"}–${r.priceRange.maxCents !== null ? formatPrice(r.priceRange.maxCents, "CAD") : "any"}`
          : ""}{" "}
        · {r.considered} listings compared ({r.sources.map((s) => `${s.marketplace} ${s.results}`).join(", ")})
      </p>
      {failed.length ? (
        <p className="text-xs break-words text-warn">
          {failed.map((s) => `${s.marketplace}: ${s.errors[0]}`).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

interface Area {
  preset: string;
  radiusKm: number;
}

const AREA_KEY = "flipwatch.huntArea";

/** The area picked on this device last time, if it's still a valid preset. */
function parseArea(raw: string | null, presets: string[]): Area | null {
  try {
    const value = JSON.parse(raw ?? "null") as Partial<Area> | null;
    if (value && typeof value.preset === "string" && presets.includes(value.preset) && typeof value.radiusKm === "number") {
      return { preset: value.preset, radiusKm: Math.min(500, Math.max(1, Math.round(value.radiusKm))) };
    }
  } catch {
    // corrupt: use the default
  }
  return null;
}

function readStoredArea(): string | null {
  try {
    return localStorage.getItem(AREA_KEY);
  } catch {
    return null; // storage blocked
  }
}

function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function AreaPicker({ presets, area, onChange }: { presets: string[]; area: Area; onChange: (area: Area) => void }) {
  const [open, setOpen] = useState(false);
  // What's typed while editing ("4" on the way to "40"); otherwise the box shows the current radius.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 font-medium text-muted hover:bg-surface-2 hover:text-fg"
      >
        <MapPin className="size-3.5" aria-hidden />
        {area.preset} · {area.radiusKm} km
      </button>
      {open ? (
        <div className="mt-2 space-y-2 rounded-lg border border-border bg-surface-2/60 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={area.preset}
              onChange={(e) => onChange({ ...area, preset: e.target.value })}
              aria-label="Location"
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 text-sm"
            >
              {presets.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1.5">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={500}
                value={draft ?? String(area.radiusKm)}
                onChange={(e) => {
                  setDraft(e.target.value);
                  const n = Number(e.target.value);
                  if (Number.isFinite(n) && n >= 1 && n <= 500) onChange({ ...area, radiusKm: Math.round(n) });
                }}
                onBlur={() => setDraft(null)}
                aria-label="Radius in km"
                className="h-9 w-20 rounded-lg border border-border bg-surface px-2 text-sm tabular-nums"
              />
              km
            </label>
          </div>
          <p className="text-muted">
            Craigslist and Kijiji use this radius. Facebook searches this city but always uses the radius saved on your Facebook
            account (change it on Marketplace → your location).
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function HuntChat({
  turns,
  aiConfigured,
  aiMessage,
  presets,
  defaultArea,
}: {
  turns: HuntTurn[];
  aiConfigured: boolean;
  aiMessage: string | null;
  presets: string[];
  defaultArea: Area;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  // What this device picked last (read after hydration: the server has no localStorage), else Settings' default.
  const stored = useSyncExternalStore(subscribeStorage, readStoredArea, () => null);
  const [picked, setPicked] = useState<Area | null>(null);
  const area = picked ?? parseArea(stored, presets) ?? defaultArea;
  const changeArea = (next: Area) => {
    setPicked(next);
    try {
      localStorage.setItem(AREA_KEY, JSON.stringify(next));
    } catch {
      // not remembered, still used for this hunt
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Follow-ups build on the last hunt until the user starts a new topic.
  const [freshAfter, setFreshAfter] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const running = turns.some((t) => t.status === "running");
  const last = turns.at(-1);
  const context = last && last.status === "done" && (freshAfter === null || last.id > freshAfter) ? last : null;

  // While a hunt runs, refresh the page data every few seconds for its progress and result.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [running, router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, last?.status]);

  function submit(text: string) {
    const value = text.trim();
    if (!value || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await startHuntAction({ prompt: value, parentId: context?.id ?? null, area });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPrompt("");
      setFreshAfter(null);
      router.refresh();
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit(prompt);
  }

  return (
    <div className="space-y-4 pb-4">
      {turns.length === 0 ? (
        <Card>
          <CardContent className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="size-4 text-accent" aria-hidden /> Try one of these
            </p>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  disabled={!aiConfigured || pending}
                  onClick={() => submit(ex)}
                  className="rounded-full border border-border bg-surface px-3 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-60"
                >
                  {ex}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {turns.map((turn) => (
        <div key={turn.id} className="space-y-2">
          <div className="flex justify-end">
            <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-sm break-words text-accent-contrast">{turn.prompt}</p>
          </div>
          <div className="rounded-2xl rounded-bl-md border border-border bg-surface px-3.5 py-3">
            <Answer turn={turn} />
          </div>
          {freshAfter === turn.id ? (
            <p className="text-center text-xs text-muted">— new topic —</p>
          ) : null}
        </div>
      ))}
      <div ref={bottomRef} />

      <form
        onSubmit={onSubmit}
        className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-20 space-y-2 rounded-xl border border-border bg-surface/95 p-2.5 shadow-lg backdrop-blur md:bottom-4"
      >
        {!aiConfigured ? <p className="text-xs text-warn">{aiMessage ?? "AI is not configured."}</p> : null}
        <AreaPicker presets={presets} area={area} onChange={changeArea} />
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        <div className="flex items-end gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(prompt);
              }
            }}
            rows={1}
            maxLength={1000}
            disabled={!aiConfigured}
            placeholder={context ? "Refine it — “cheaper”, “only RTX 30 series”…" : "What are you looking for?"}
            aria-label="What are you looking for?"
            className="max-h-32 min-h-10 flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:outline-2 focus:outline-accent"
          />
          <Button type="submit" size="md" disabled={!aiConfigured || pending || !prompt.trim()} aria-label="Hunt">
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
          </Button>
        </div>
        {context ? (
          <div className="flex items-center justify-between gap-2 text-xs text-muted">
            <span className="truncate">Following up on “{context.prompt}”</span>
            <button type="button" onClick={() => setFreshAfter(context.id)} className="inline-flex shrink-0 items-center gap-1 font-medium text-accent">
              <MessageSquarePlus className="size-3.5" aria-hidden /> New topic
            </button>
          </div>
        ) : running ? (
          <p className="text-xs text-muted">
            <Badge tone="neutral">1 hunt running</Badge> You can start another or come back later.
          </p>
        ) : null}
      </form>
    </div>
  );
}
