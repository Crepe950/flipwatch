import Link from "next/link";
import { Activity } from "lucide-react";
import { formatDuration } from "@/components/searches/describe";
import { Badge } from "@/components/ui/badge";
import { MarketplaceBadge } from "@/components/ui/marketplace-badge";
import { TimeAgo } from "@/components/ui/time-ago";
import type { WorkerMode } from "@/lib/config";
import type { HeartbeatStatus } from "@/lib/queries/settings";
import type { MarketplaceId } from "@/lib/types";
import { SettingsSection } from "./section";

export interface ScrapeRunView {
  id: number;
  startedAt: string;
  searchId: number | null;
  searchName: string | null;
  marketplace: MarketplaceId;
  resultCount: number;
  newCount: number;
  priceDropCount: number;
  durationMs: number;
  error: string | null;
}

export interface WorkerView {
  mode: WorkerMode;
  status: HeartbeatStatus;
  heartbeatAt: string | null;
  pid?: number;
  hostname?: string;
}

const MODE_TEXT: Record<WorkerMode, string> = {
  inline: "The web server polls searches itself.",
  external: "A separate worker process (npm run worker) polls searches.",
  off: "Nothing polls automatically. Use “Run now” or call /api/cron/tick from a scheduler.",
};

function HeartbeatBadge({ worker }: { worker: WorkerView }) {
  if (worker.status === "live") return <Badge tone="green">Live</Badge>;
  if (worker.status === "stalled") return <Badge tone="amber">Stalled</Badge>;
  return <Badge>{worker.status === "off" ? "Off" : "No heartbeat"}</Badge>;
}

function RunsTable({ runs }: { runs: ScrapeRunView[] }) {
  if (runs.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted">No marketplace fetches recorded yet.</p>
    );
  }
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="text-xs text-muted">
          <tr className="border-b border-border">
            <th className="py-2 pr-3 font-medium">When</th>
            <th className="py-2 pr-3 font-medium">Search</th>
            <th className="py-2 pr-3 font-medium">Marketplace</th>
            <th className="py-2 pr-3 text-right font-medium">Results</th>
            <th className="py-2 pr-3 text-right font-medium">New</th>
            <th className="py-2 pr-3 text-right font-medium">Drops</th>
            <th className="py-2 pr-3 text-right font-medium">Time</th>
            <th className="py-2 font-medium">Error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {runs.map((run) => (
            <tr key={run.id} className="align-top">
              <td className="py-2 pr-3 whitespace-nowrap text-muted">
                <TimeAgo date={run.startedAt} />
              </td>
              <td className="max-w-48 truncate py-2 pr-3">
                {run.searchId && run.searchName ? (
                  <Link href={`/searches/${run.searchId}/edit`} className="hover:underline" title={run.searchName}>
                    {run.searchName}
                  </Link>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className="py-2 pr-3">
                <MarketplaceBadge marketplace={run.marketplace} />
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{run.resultCount}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {run.newCount ? <span className="font-medium text-accent">{run.newCount}</span> : 0}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{run.priceDropCount}</td>
              <td className="py-2 pr-3 text-right whitespace-nowrap text-muted tabular-nums">{formatDuration(run.durationMs)}</td>
              <td className="max-w-64 py-2">
                {run.error ? (
                  <span className="line-clamp-2 break-words text-danger" title={run.error}>
                    {run.error}
                  </span>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WorkerSection({ worker, runs }: { worker: WorkerView; runs: ScrapeRunView[] }) {
  return (
    <SettingsSection
      id="worker"
      icon={Activity}
      title="Worker & health"
      description="The scheduler that polls your searches, and its most recent marketplace fetches."
      aside={<HeartbeatBadge worker={worker} />}
    >
      <dl className="mb-5 grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Mode</dt>
          <dd className="mt-0.5">
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">WORKER_MODE={worker.mode}</code>
            <p className="mt-1 text-muted">{MODE_TEXT[worker.mode]}</p>
          </dd>
        </div>
        <div>
          <dt className="text-muted">Heartbeat</dt>
          <dd className="mt-0.5">
            {worker.heartbeatAt ? (
              <>
                Last beat <TimeAgo date={worker.heartbeatAt} />
                {worker.hostname || worker.pid ? (
                  <span className="text-muted"> · {[worker.hostname, worker.pid ? `pid ${worker.pid}` : null].filter(Boolean).join(" · ")}</span>
                ) : null}
                {worker.status === "stalled" ? <p className="mt-1 text-warn">No heartbeat for over 2 minutes; check the worker logs.</p> : null}
              </>
            ) : worker.mode === "off" ? (
              <span className="text-muted">Polling is off.</span>
            ) : (
              <span className="text-muted">No heartbeat recorded yet{worker.mode === "external" ? " — start it with npm run worker." : "."}</span>
            )}
          </dd>
        </div>
      </dl>
      <h3 className="mb-2 text-sm font-semibold">Recent fetches</h3>
      <RunsTable runs={runs} />
    </SettingsSection>
  );
}
