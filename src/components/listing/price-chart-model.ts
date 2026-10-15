/** Pure geometry for the price-history step chart (no React), kept separate so it can be tested. */

export interface PriceObservation {
  /** Epoch ms. */
  t: number;
  priceCents: number | null;
}

/** A price that held from `start` until `end` (the next change, or the end of the chart). */
export interface PriceStep {
  start: number;
  end: number;
  priceCents: number | null;
  /** Difference from the previous priced step, null for the first. */
  changeCents: number | null;
}

/** Collapse repeated observations of the same price into steps (step-after interpolation). */
export function toSteps(points: PriceObservation[], endAt: number): PriceStep[] {
  const sorted = points.filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const steps: PriceStep[] = [];
  let lastPriced: number | null = null;
  for (const p of sorted) {
    const prev = steps.at(-1);
    if (prev && prev.priceCents === p.priceCents) continue;
    if (prev) prev.end = p.t;
    steps.push({
      start: p.t,
      end: p.t,
      priceCents: p.priceCents,
      changeCents: p.priceCents !== null && lastPriced !== null ? p.priceCents - lastPriced : null,
    });
    if (p.priceCents !== null) lastPriced = p.priceCents;
  }
  const last = steps.at(-1);
  if (last) last.end = Math.max(last.start, endAt);
  return steps;
}

/** "Nice" axis ticks (1 / 2 / 2.5 / 5 × 10ⁿ) covering [min, max]; never below zero. */
export function niceTicks(min: number, max: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (hi === lo) {
    const pad = Math.max(Math.abs(hi) * 0.2, 1000);
    lo -= pad;
    hi += pad;
  }
  const rough = (hi - lo) / Math.max(1, count - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;
  const niceLo = Math.max(0, Math.floor(lo / step) * step);
  const niceHi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = niceLo; v <= niceHi + step / 1e6; v += step) ticks.push(Math.round(v));
  return { lo: niceLo, hi: niceHi, ticks };
}

export interface ChartBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ChartGeometry {
  x: (t: number) => number;
  y: (cents: number) => number;
  /** Line path(s): one sub-path per run of priced steps (null prices leave a gap). */
  line: string;
  area: string;
  ticks: number[];
  t0: number;
  t1: number;
}

export function buildGeometry(steps: PriceStep[], box: ChartBox): ChartGeometry | null {
  const priced = steps.filter((s) => s.priceCents !== null);
  if (priced.length === 0) return null;
  const values = priced.map((s) => s.priceCents as number);
  const { lo, hi, ticks } = niceTicks(Math.min(...values), Math.max(...values));
  const t0 = steps[0].start;
  const t1 = Math.max(steps.at(-1)!.end, t0 + 60 * 60 * 1000);
  const plotW = Math.max(1, box.width - box.left - box.right);
  const plotH = Math.max(1, box.height - box.top - box.bottom);
  const x = (t: number) => box.left + ((t - t0) / (t1 - t0)) * plotW;
  const y = (cents: number) => box.top + (1 - (cents - lo) / Math.max(1, hi - lo)) * plotH;
  const base = box.top + plotH;

  const r = (n: number) => Math.round(n * 10) / 10;
  let line = "";
  let area = "";
  let run: PriceStep[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    let d = `M${r(x(first.start))} ${r(y(first.priceCents!))}`;
    for (let i = 0; i < run.length; i++) {
      const s = run[i];
      if (i > 0) d += `V${r(y(s.priceCents!))}`;
      d += `H${r(x(s.end))}`;
    }
    line += d;
    area += `M${r(x(first.start))} ${r(base)}V${r(y(first.priceCents!))}${d.slice(d.indexOf("H"))}V${r(base)}Z`;
    run = [];
  };
  for (const s of steps) {
    if (s.priceCents === null) flush();
    else run.push(s);
  }
  flush();
  return { x, y, line, area, ticks, t0, t1 };
}

/** Index of the step whose start is closest to time `t` (the crosshair snaps to price changes). */
export function nearestStep(steps: PriceStep[], t: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  steps.forEach((s, i) => {
    const dist = Math.abs(s.start - t);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  });
  return best;
}
