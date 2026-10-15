/**
 * Pure CRM-pipeline calculations (profit, ROI, summary). No database or framework imports so it
 * can be used from server code, client components and tests alike.
 */
import { dollarsToCents, formatPrice } from "./format";
import { DEAL_STAGES, type DealStage } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The money fields of a deal that the calculations need. */
export interface DealMoney {
  purchaseCents: number | null;
  salePriceCents: number | null;
  feesCents: number | null;
  otherCostsCents: number | null;
}

export interface SummaryDeal extends DealMoney {
  stage: DealStage;
  /** Currency of the underlying listing; totals are never mixed across currencies. */
  currency: string;
  purchasedAt: Date | null;
  soldAt: Date | null;
  followUpAt: Date | null;
}

/** Amount per currency code, e.g. { CAD: 125000 }. */
export type MoneyTotals = Record<string, number>;

export interface PipelineSummary {
  /** Purchase price + other costs of deals that are bought but not sold yet (purchased / listed). */
  capitalTiedUp: MoneyTotals;
  /** Sum of profit over sold deals whose profit can be computed. */
  realizedProfit: MoneyTotals;
  soldCount: number;
  /** Mean ROI (profit ÷ cost basis) over sold deals; null when no sold deal has a cost basis. */
  avgRoi: number | null;
  /** Mean days from purchase to sale over sold deals with both timestamps. */
  avgDaysToSell: number | null;
  /** Deals still before purchase: lead, contacted, negotiating. */
  openLeads: number;
  /** Open deals whose follow-up date is today or already past. */
  followUpsDue: number;
  followUpsOverdue: number;
}

const OPEN_LEAD_STAGES: ReadonlySet<DealStage> = new Set(["lead", "contacted", "negotiating"]);
const HOLDING_STAGES: ReadonlySet<DealStage> = new Set(["purchased", "listed"]);

/** Stages where the flip is still in progress (not sold and not passed on). */
export function isOpenStage(stage: DealStage): boolean {
  return stage !== "sold" && stage !== "passed";
}

/**
 * Position of a stage in the forward flow (lead → sold). "passed" is off the flow and returns -1,
 * so it is never considered "earlier" than another stage.
 */
export function stageRank(stage: DealStage): number {
  return stage === "passed" ? -1 : DEAL_STAGES.indexOf(stage);
}

/** Sale − purchase − fees − other costs. Null until the deal has both a purchase and a sale price. */
export function dealProfitCents(deal: DealMoney): number | null {
  if (deal.purchaseCents === null || deal.salePriceCents === null) return null;
  return deal.salePriceCents - deal.purchaseCents - (deal.feesCents ?? 0) - (deal.otherCostsCents ?? 0);
}

/** Everything spent on the flip: purchase + fees + other costs. Null without a purchase price. */
export function dealCostBasisCents(deal: DealMoney): number | null {
  if (deal.purchaseCents === null) return null;
  return deal.purchaseCents + (deal.feesCents ?? 0) + (deal.otherCostsCents ?? 0);
}

/** Profit ÷ cost basis (0.25 = 25 %). Null when profit is unknown or the item cost nothing. */
export function dealRoi(deal: DealMoney): number | null {
  const profit = dealProfitCents(deal);
  const cost = dealCostBasisCents(deal);
  if (profit === null || cost === null || cost <= 0) return null;
  return profit / cost;
}

function addTo(totals: MoneyTotals, currency: string, cents: number) {
  totals[currency] = (totals[currency] ?? 0) + cents;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function pipelineSummary(deals: SummaryDeal[], now: Date): PipelineSummary {
  const capitalTiedUp: MoneyTotals = {};
  const realizedProfit: MoneyTotals = {};
  const rois: number[] = [];
  const daysToSell: number[] = [];
  let soldCount = 0;
  let openLeads = 0;
  let followUpsDue = 0;
  let followUpsOverdue = 0;

  for (const deal of deals) {
    if (HOLDING_STAGES.has(deal.stage)) {
      addTo(capitalTiedUp, deal.currency, (deal.purchaseCents ?? 0) + (deal.otherCostsCents ?? 0));
    }
    if (deal.stage === "sold") {
      soldCount++;
      const profit = dealProfitCents(deal);
      if (profit !== null) addTo(realizedProfit, deal.currency, profit);
      const roi = dealRoi(deal);
      if (roi !== null) rois.push(roi);
      if (deal.purchasedAt && deal.soldAt && deal.soldAt >= deal.purchasedAt) {
        daysToSell.push((deal.soldAt.getTime() - deal.purchasedAt.getTime()) / DAY_MS);
      }
    }
    if (OPEN_LEAD_STAGES.has(deal.stage)) openLeads++;
    if (isOpenStage(deal.stage)) {
      const state = followUpState(deal.followUpAt, now);
      if (state === "today" || state === "overdue") followUpsDue++;
      if (state === "overdue") followUpsOverdue++;
    }
  }

  return {
    capitalTiedUp,
    realizedProfit,
    soldCount,
    avgRoi: mean(rois),
    avgDaysToSell: mean(daysToSell),
    openLeads,
    followUpsDue,
    followUpsOverdue,
  };
}

// --- Follow-up dates ------------------------------------------------------------------------
// A follow-up is a calendar date. It is stored as 12:00 UTC of that date so the date part is the
// same in every timezone from UTC−11 to UTC+11, and "today" is judged in the server's local zone.

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" of a stored follow-up date. */
export function followUpDateKey(followUpAt: Date): string {
  return followUpAt.toISOString().slice(0, 10);
}

/** Parse an <input type="date"> value; null for blank, undefined for invalid input. */
export function followUpFromInput(value: string | null | undefined): Date | null | undefined {
  const v = (value ?? "").trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  // Reject roll-overs such as 2026-02-31.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date;
}

export function followUpToInput(followUpAt: Date | null | undefined): string {
  return followUpAt ? followUpDateKey(followUpAt) : "";
}

export type FollowUpState = "overdue" | "today" | "upcoming";

export function followUpState(followUpAt: Date | null | undefined, now: Date): FollowUpState | null {
  if (!followUpAt) return null;
  const due = followUpDateKey(followUpAt);
  const today = localDateKey(now);
  return due < today ? "overdue" : due === today ? "today" : "upcoming";
}

/** "Sep 30" style label for a follow-up date (formatted in UTC to keep the stored calendar date). */
export function formatFollowUpDate(followUpAt: Date): string {
  return followUpAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// --- Stage bookkeeping -----------------------------------------------------------------------

export interface StageTimestamps {
  stage: DealStage;
  createdAt: Date;
  updatedAt: Date;
  stageChangedAt: Date;
  contactedAt: Date | null;
  purchasedAt: Date | null;
  soldAt: Date | null;
}

/** Timestamps to set when a deal enters `stage` (only those still unset). */
export function stageEntryPatch(
  deal: Pick<StageTimestamps, "contactedAt" | "purchasedAt" | "soldAt">,
  stage: DealStage,
  now: Date,
): Partial<Pick<StageTimestamps, "contactedAt" | "purchasedAt" | "soldAt">> {
  if (stage === "contacted" && !deal.contactedAt) return { contactedAt: now };
  if (stage === "purchased" && !deal.purchasedAt) return { purchasedAt: now };
  if (stage === "sold" && !deal.soldAt) return { soldAt: now };
  return {};
}

/** When the deal entered its current stage. */
export function stageEnteredAt(deal: Pick<StageTimestamps, "stageChangedAt">): Date {
  return deal.stageChangedAt;
}

export function daysInStage(deal: Pick<StageTimestamps, "stageChangedAt">, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - stageEnteredAt(deal).getTime()) / DAY_MS));
}

// --- Money input -----------------------------------------------------------------------------

const MONEY_INPUT = /^\$?\s*(\d{1,3}(,\d{3})+|\d+)?(\.\d{1,2})?$/;
export const MAX_MONEY_CENTS = 100_000_000;

/**
 * Parse a dollar amount typed into a form ("1,250", "$40.5"): cents, null for blank, or undefined
 * when the text is not a plain non-negative amount (dollarsToCents alone would accept "1.2.3").
 */
export function parseMoneyInput(raw: unknown): number | null | undefined {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;
  if (!MONEY_INPUT.test(value) || !/\d/.test(value)) return undefined;
  const cents = dollarsToCents(value);
  return cents !== null && cents <= MAX_MONEY_CENTS ? cents : undefined;
}

// --- Display helpers -------------------------------------------------------------------------

/** "$1,250" for one currency, "$1,250 CAD · $300 USD" when mixed, "$0" when empty. */
export function formatMoneyTotals(totals: MoneyTotals, fallbackCurrency = "USD"): string {
  const entries = Object.entries(totals).filter(([, cents]) => cents !== 0);
  if (entries.length === 0) return formatPlain(0, fallbackCurrency);
  if (entries.length === 1) return formatPlain(entries[0][1], entries[0][0]);
  return entries
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([currency, cents]) => `${formatPlain(cents, currency)} ${currency}`)
    .join(" · ");
}

/** formatPrice without the "Free" wording and with a proper minus sign for losses. */
function formatPlain(cents: number, currency: string): string {
  if (cents === 0) {
    return new Intl.NumberFormat(currency === "CAD" ? "en-CA" : "en-US", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: 0,
    }).format(0);
  }
  const text = formatPrice(Math.abs(cents), currency, { compact: true });
  return cents < 0 ? `−${text}` : text;
}

export function formatRoi(roi: number | null): string {
  if (roi === null || !Number.isFinite(roi)) return "—";
  const pct = Math.round(roi * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}%`;
}
