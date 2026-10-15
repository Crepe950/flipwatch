import Link from "next/link";
import { TrendingDown } from "lucide-react";
import { QUIET_TOOLTIP } from "@/components/feed/quiet";
import { ScoreWithReason } from "@/components/feed/score-with-reason";
import { Badge } from "@/components/ui/badge";
import { TimeAgo } from "@/components/ui/time-ago";
import { cn } from "@/lib/cn";
import { formatSignedPrice } from "@/lib/format";
import type { ListingMatch } from "@/lib/queries/listings";

export function MatchedSearches({ matches, currency }: { matches: ListingMatch[]; currency: string }) {
  if (matches.length === 0) {
    return <p className="text-sm text-muted">This listing isn&apos;t matched by any of your searches anymore.</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {matches.map((m) => (
        <li key={m.matchId} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/?search=${m.searchId}`} className="font-medium hover:underline">
              {m.searchName}
            </Link>
            <ScoreWithReason score={m.dealScore} reason={m.dealScoreReason} />
            {m.lastEvent === "price_drop" ? (
              <Badge tone="blue">
                <TrendingDown className="size-3" aria-hidden />
                Price drop
              </Badge>
            ) : null}
            {m.silent ? (
              <Badge title={QUIET_TOOLTIP} className="font-normal">
                Quiet
              </Badge>
            ) : null}
            {m.dismissed ? <Badge className="font-normal">Dismissed</Badge> : null}
            <TimeAgo date={m.lastEventAt} className="ml-auto text-xs text-muted" />
          </div>
          {m.dealScoreReason || m.estimatedProfitCents !== null ? (
            <p className="text-xs text-muted">
              {m.dealScoreReason}
              {m.dealScoreReason && m.estimatedProfitCents !== null ? " · " : null}
              {m.estimatedProfitCents !== null ? (
                <span className={cn("font-medium", m.estimatedProfitCents > 0 && "text-accent")}>
                  {formatSignedPrice(Math.round(m.estimatedProfitCents / 100) * 100, currency)} est. profit
                </span>
              ) : null}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
