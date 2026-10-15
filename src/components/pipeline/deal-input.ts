/** Validation wording for the deal form (pure; used by the pipeline server actions). */
import { MAX_MONEY_CENTS } from "@/lib/deals";
import { dollarsToCents, formatPrice } from "@/lib/format";

/** Why parseMoneyInput() rejected a deal amount, in words that say how to fix it. */
export function moneyInputError(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (/^\$?\s*-/.test(value)) return "Amounts can't be negative";
  const cents = /^\$?\s*[\d,]*\.?\d*$/.test(value) ? dollarsToCents(value) : null;
  if (cents !== null && cents > MAX_MONEY_CENTS) return `Enter an amount up to ${formatPrice(MAX_MONEY_CENTS)}`;
  return "Enter an amount like 250 or 249.99";
}
