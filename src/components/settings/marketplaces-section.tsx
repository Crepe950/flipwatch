import { CircleCheck, CircleSlash, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { MarketplaceBadge } from "@/components/ui/marketplace-badge";
import { TimeAgo } from "@/components/ui/time-ago";
import type { MarketplaceId } from "@/lib/types";
import { ClearBackoffButton } from "./clear-backoff-button";
import { SettingsSection } from "./section";

export interface MarketplaceHealthView {
  consecutiveFailures: number;
  /** Minutes of backoff left; 0 when not backing off. */
  backoffMinutesLeft: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface MarketplaceStatusView {
  id: MarketplaceId;
  displayName: string;
  countries: string[];
  ok: boolean;
  message?: string;
  health: MarketplaceHealthView | null;
}

/** Where each marketplace that needs setup is configured. */
const SETUP: Partial<Record<MarketplaceId, { label: string; href: string }>> = {
  ebay: { label: "Settings → eBay", href: "#ebay" },
  facebook: { label: "Settings → Facebook", href: "#facebook" },
};

function HealthLine({ health }: { health: MarketplaceHealthView | null }) {
  if (!health) return <p className="text-sm text-muted">Not queried yet.</p>;
  return (
    <div className="space-y-1 text-sm">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
        {health.backoffMinutesLeft > 0 ? (
          <Badge tone="amber">Backing off · {health.backoffMinutesLeft} min left</Badge>
        ) : health.consecutiveFailures > 0 ? (
          <Badge tone="amber">Retrying</Badge>
        ) : (
          <Badge tone="green">Healthy</Badge>
        )}
        {health.consecutiveFailures > 0 ? (
          <span>
            {health.consecutiveFailures} failure{health.consecutiveFailures === 1 ? "" : "s"} in a row
          </span>
        ) : null}
        <span>Last success {health.lastSuccessAt ? <TimeAgo date={health.lastSuccessAt} /> : "never"}</span>
      </p>
      {health.lastError ? (
        <p className="line-clamp-2 break-words text-danger" title={health.lastError}>
          {health.lastErrorAt ? (
            <>
              <TimeAgo date={health.lastErrorAt} />:{" "}
            </>
          ) : null}
          {health.lastError}
        </p>
      ) : null}
    </div>
  );
}

export function MarketplacesSection({ marketplaces }: { marketplaces: MarketplaceStatusView[] }) {
  const ready = marketplaces.filter((m) => m.ok).length;
  return (
    <SettingsSection
      id="marketplaces"
      icon={Store}
      title="Marketplaces"
      description={`${ready} of ${marketplaces.length} ready. Failing marketplaces back off automatically; clear it to retry right away.`}
    >
      <ul className="divide-y divide-border">
        {marketplaces.map((m) => {
          const setup = SETUP[m.id];
          const canClear = Boolean(m.health && (m.health.backoffMinutesLeft > 0 || m.health.consecutiveFailures > 0));
          return (
            <li key={m.id} className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:gap-6">
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <MarketplaceBadge marketplace={m.id} />
                  {m.ok ? (
                    <span className="inline-flex items-center gap-1 text-sm text-accent">
                      <CircleCheck className="size-4" /> Ready
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-sm text-danger">
                      <CircleSlash className="size-4" /> Not available
                    </span>
                  )}
                  <span className="text-xs text-muted">{m.countries.join(" · ")}</span>
                </div>
                {m.message ? <p className="text-sm break-words text-muted">{m.message}</p> : null}
                {setup ? (
                  <p className="text-xs text-muted">
                    Set up in{" "}
                    <a href={setup.href} className="font-medium text-accent hover:underline">
                      {setup.label}
                    </a>
                    .
                  </p>
                ) : (
                  <p className="text-xs text-muted">No setup needed.</p>
                )}
              </div>
              <HealthLine health={m.health} />
              <div className="md:text-right">
                {canClear ? <ClearBackoffButton marketplace={m.id} /> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}
