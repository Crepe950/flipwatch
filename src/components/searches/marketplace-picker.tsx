"use client";

import { Check, CircleSlash, TriangleAlert } from "lucide-react";
import { MarketplaceBadge } from "@/components/ui/marketplace-badge";
import { cn } from "@/lib/cn";
import type { MarketplaceId } from "@/lib/types";

/** Serializable adapter info (functions can't cross the server/client boundary). */
export interface MarketplaceOption {
  id: MarketplaceId;
  displayName: string;
  countries: string[];
  ok: boolean;
  message?: string;
  /** Shortest time the adapter allows between two checks of one search. */
  minIntervalSec: number;
}

export function MarketplacePicker({
  options,
  selected,
  countryCode,
  onChange,
  invalid,
}: {
  options: MarketplaceOption[];
  selected: MarketplaceId[];
  countryCode: string;
  onChange: (next: MarketplaceId[]) => void;
  invalid?: boolean;
}) {
  const country = countryCode.trim().toUpperCase();
  const toggle = (id: MarketplaceId) => onChange(selected.includes(id) ? selected.filter((m) => m !== id) : [...selected, id]);

  return (
    <div className={cn("grid gap-2 sm:grid-cols-2", invalid && "rounded-xl outline-2 outline-offset-4 outline-danger")}>
      {options.map((option) => {
        const isSelected = selected.includes(option.id);
        // Unavailable adapters can't be added, but an already-selected one can still be removed.
        const disabled = !option.ok && !isSelected;
        const wrongCountry = country.length === 2 && !option.countries.includes(country);
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled}
            onClick={() => toggle(option.id)}
            className={cn(
              "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              isSelected ? "border-accent bg-accent-soft/50" : "border-border bg-surface hover:bg-surface-2",
              disabled && "cursor-not-allowed opacity-60 hover:bg-surface",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border",
                isSelected ? "border-accent bg-accent text-accent-contrast" : "border-border bg-surface",
              )}
            >
              {isSelected ? <Check className="size-3.5" /> : null}
            </span>
            <span className="min-w-0 flex-1 space-y-1">
              <span className="flex flex-wrap items-center gap-1.5">
                <MarketplaceBadge marketplace={option.id} />
                <span className="text-xs text-muted">{option.countries.join(" · ")}</span>
              </span>
              {!option.ok ? (
                <span className="flex items-start gap-1 text-xs text-danger">
                  <CircleSlash className="mt-px size-3.5 shrink-0" />
                  {/* Adapter messages can be long setup guides; Settings → Marketplaces shows them in full. */}
                  <span className="line-clamp-3" title={option.message}>
                    {option.message ?? "Unavailable"}
                  </span>
                </span>
              ) : option.message ? (
                <span className="line-clamp-2 text-xs text-muted" title={option.message}>
                  {option.message}
                </span>
              ) : null}
              {wrongCountry && (option.ok || isSelected) ? (
                <span className="flex items-start gap-1 text-xs text-warn">
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  <span>
                    {option.displayName} doesn&apos;t serve {country}; it will be skipped for this location.
                  </span>
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
