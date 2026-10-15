import type { ReactNode } from "react";
import { Activity, CircleOff, CirclePause } from "lucide-react";
import { TimeAgo } from "@/components/ui/time-ago";
import { cn } from "@/lib/cn";
import type { FeedStats, WorkerState } from "@/lib/queries/feed";

function Tile({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-32 shrink-0 rounded-xl border border-border bg-surface px-3 py-2.5 md:min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tracking-tight">{children}</dd>
      {sub ? <dd className="truncate text-xs text-muted">{sub}</dd> : null}
    </div>
  );
}

const WORKER: Record<WorkerState, { label: string; icon: typeof Activity; className: string }> = {
  live: { label: "Live", icon: Activity, className: "text-accent" },
  stalled: { label: "Stalled", icon: CirclePause, className: "text-warn" },
  off: { label: "Off", icon: CircleOff, className: "text-muted" },
};

const MODE_LABEL = { inline: "In-app", external: "External", off: "Polling disabled" } as const;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function WorkerDetail({ worker }: { worker: FeedStats["worker"] }) {
  if (worker.state === "live") {
    return (
      <>
        {worker.beatSource ? capitalize(worker.beatSource) : MODE_LABEL[worker.mode]} · <TimeAgo date={worker.lastBeatAt} />
      </>
    );
  }
  if (worker.state === "stalled") {
    return (
      <>
        Last beat <TimeAgo date={worker.lastBeatAt} />
      </>
    );
  }
  return <>{worker.mode === "off" ? MODE_LABEL.off : "No heartbeat yet"}</>;
}

export function StatsStrip({ stats }: { stats: FeedStats }) {
  const worker = WORKER[stats.worker.state];
  const WorkerIcon = worker.icon;
  return (
    <dl className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-5 md:overflow-visible md:px-0">
      <Tile label="New · last hour">{stats.newLastHour}</Tile>
      <Tile label="New · 24 h">{stats.newLast24h}</Tile>
      <Tile label="Price drops · 24 h">{stats.priceDropsLast24h}</Tile>
      <Tile label="Active searches" sub={stats.totalSearches > stats.activeSearches ? `${stats.totalSearches - stats.activeSearches} paused` : undefined}>
        {stats.activeSearches}
      </Tile>
      <Tile label="Worker" sub={<WorkerDetail worker={stats.worker} />}>
        <span className={cn("inline-flex items-center gap-1.5", worker.className)}>
          <WorkerIcon className={cn("size-4", stats.worker.state === "live" && "animate-pulse")} aria-hidden />
          {worker.label}
        </span>
      </Tile>
    </dl>
  );
}
