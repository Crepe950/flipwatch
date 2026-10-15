"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatPrice, formatSignedPrice } from "@/lib/format";
import { buildGeometry, nearestStep, toSteps, type PriceObservation, type PriceStep } from "./price-chart-model";

const HEIGHT = 180;
const BOX = { top: 18, right: 14, bottom: 26, left: 58 };
const MAX_MARKERS = 24;

function formatWhen(t: number, withTime = true): string {
  return new Date(t).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

function describe(step: PriceStep, currency: string): string {
  const price = step.priceCents === null ? "No price" : formatPrice(step.priceCents, currency);
  const change = step.changeCents ? ` (${formatSignedPrice(step.changeCents, currency)})` : "";
  return `${price}${change} from ${formatWhen(step.start)}`;
}

/**
 * Single-series step chart of a listing's observed prices. Series colour is the accent in light
 * mode and a darker validated step (#26ad6c, OKLCH L≈0.65) in dark mode, where the UI accent is too
 * light for a chart mark. Hover/focus snaps a crosshair to each price change; a table view mirrors
 * every value.
 */
export function PriceHistoryChart({ points, endAt, currency }: { points: PriceObservation[]; endAt: number; currency: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const steps = toSteps(points, endAt);
  const priced = steps.filter((s) => s.priceCents !== null);
  const mounted = width !== null;
  const geometry = mounted && width > 0 ? buildGeometry(steps, { width, height: HEIGHT, ...BOX }) : null;

  if (priced.length === 0) {
    return <p className="text-sm text-muted">No price has been recorded for this listing.</p>;
  }

  const first = priced[0];
  const last = priced.at(-1)!;
  const totalChange = last.priceCents! - first.priceCents!;
  const summary =
    steps.length === 1 || totalChange === 0
      ? `Unchanged at ${formatPrice(last.priceCents, currency)}`
      : `${formatPrice(first.priceCents, currency)} → ${formatPrice(last.priceCents, currency)} (${formatSignedPrice(totalChange, currency)}) over ${priced.length - 1} ${priced.length === 2 ? "change" : "changes"}`;

  function onPointerMove(e: PointerEvent<SVGRectElement>) {
    if (!geometry) return;
    const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = geometry.t0 + ((px - BOX.left) / Math.max(1, rect.width - BOX.left - BOX.right)) * (geometry.t1 - geometry.t0);
    setActive(nearestStep(steps, t));
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const current = active ?? steps.length - 1;
    const next =
      e.key === "ArrowLeft" ? current - 1 : e.key === "ArrowRight" ? current + 1 : e.key === "Home" ? 0 : e.key === "End" ? steps.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(steps.length - 1, next)));
  }

  const activeStep = active !== null ? steps[active] : null;
  // Under two days both ends can fall on the same date, so the axis shows times too.
  const shortSpan = geometry !== null && geometry.t1 - geometry.t0 < 2 * 24 * 60 * 60 * 1000;
  const endX = geometry ? geometry.x(last.end) : 0;
  const endY = geometry ? geometry.y(last.priceCents!) : 0;
  const markers = steps.length <= MAX_MARKERS ? steps.filter((s) => s.priceCents !== null) : [];

  return (
    <figure className="space-y-3">
      <figcaption className="text-sm text-muted">{summary}</figcaption>
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label="Price history chart. Use the left and right arrow keys to step through price changes."
        onKeyDown={onKeyDown}
        onFocus={() => setActive((a) => a ?? steps.length - 1)}
        onBlur={() => setActive(null)}
        className="relative rounded-lg [--series:var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent dark:[--series:#26ad6c]"
        style={{ height: HEIGHT }}
      >
        {geometry && width ? (
          <svg width={width} height={HEIGHT} className="block overflow-visible" aria-hidden>
            {geometry.ticks.map((tick) => (
              <g key={tick}>
                <line x1={BOX.left} x2={width - BOX.right} y1={geometry.y(tick)} y2={geometry.y(tick)} className="stroke-border" strokeWidth={1} shapeRendering="crispEdges" />
                <text x={BOX.left - 8} y={geometry.y(tick)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
                  {formatPrice(tick, currency, { compact: true })}
                </text>
              </g>
            ))}
            <text x={BOX.left} y={HEIGHT - 6} textAnchor="start" className="fill-muted text-[11px]">
              {formatWhen(geometry.t0, shortSpan)}
            </text>
            <text x={width - BOX.right} y={HEIGHT - 6} textAnchor="end" className="fill-muted text-[11px]">
              {formatWhen(geometry.t1, shortSpan)}
            </text>

            <path d={geometry.area} className="fill-[var(--series)]" fillOpacity={0.1} />
            <path d={geometry.line} fill="none" className="stroke-[var(--series)]" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

            {markers.map((s) => (
              <g key={s.start}>
                <circle cx={geometry.x(s.start)} cy={geometry.y(s.priceCents!)} r={6} className="fill-surface" />
                <circle cx={geometry.x(s.start)} cy={geometry.y(s.priceCents!)} r={4} className="fill-[var(--series)]" />
              </g>
            ))}
            <circle cx={endX} cy={endY} r={6} className="fill-surface" />
            <circle cx={endX} cy={endY} r={4} className="fill-[var(--series)]" />
            <text
              x={endX}
              y={endY < BOX.top + 18 ? endY + 20 : endY - 12}
              textAnchor="end"
              className="fill-fg text-xs font-semibold"
            >
              {formatPrice(last.priceCents, currency)}
            </text>

            {activeStep && activeStep.priceCents !== null ? (
              <g>
                <line
                  x1={geometry.x(activeStep.start)}
                  x2={geometry.x(activeStep.start)}
                  y1={BOX.top}
                  y2={HEIGHT - BOX.bottom}
                  className="stroke-muted"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <circle cx={geometry.x(activeStep.start)} cy={geometry.y(activeStep.priceCents)} r={7} className="fill-surface" />
                <circle cx={geometry.x(activeStep.start)} cy={geometry.y(activeStep.priceCents)} r={5} className="fill-[var(--series)]" />
              </g>
            ) : null}

            <rect
              x={BOX.left}
              y={0}
              width={Math.max(0, width - BOX.left - BOX.right)}
              height={HEIGHT}
              fill="transparent"
              onPointerMove={onPointerMove}
              onPointerDown={onPointerMove}
              onPointerLeave={() => setActive(null)}
            />
          </svg>
        ) : null}

        {geometry && width && activeStep ? (
          <div
            className="pointer-events-none absolute z-10 w-max -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-lg"
            style={{
              left: Math.min(Math.max(geometry.x(activeStep.start), 70), width - 70),
              top: Math.max(0, (activeStep.priceCents !== null ? geometry.y(activeStep.priceCents) : BOX.top) - 12),
            }}
          >
            <div className="text-sm font-semibold">
              {activeStep.priceCents === null ? "No price" : formatPrice(activeStep.priceCents, currency)}
              {activeStep.changeCents ? (
                <span className="ml-1.5 font-normal text-muted">{formatSignedPrice(activeStep.changeCents, currency)}</span>
              ) : null}
            </div>
            <div className="text-muted">{formatWhen(activeStep.start)}</div>
          </div>
        ) : null}
        <p className="sr-only" aria-live="polite">
          {activeStep ? describe(activeStep, currency) : ""}
        </p>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer text-muted hover:text-fg">Show as table</summary>
        <table className="mt-2 w-full text-left">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1 font-medium">Since</th>
              <th className="py-1 text-right font-medium">Price</th>
              <th className="py-1 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {steps.map((s) => (
              <tr key={s.start} className="border-t border-border">
                <td className="py-1.5">{mounted ? formatWhen(s.start) : new Date(s.start).toISOString().slice(0, 16).replace("T", " ") + " UTC"}</td>
                <td className="py-1.5 text-right">{s.priceCents === null ? "No price" : formatPrice(s.priceCents, currency)}</td>
                <td className="py-1.5 text-right text-muted">{s.changeCents ? formatSignedPrice(s.changeCents, currency) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
