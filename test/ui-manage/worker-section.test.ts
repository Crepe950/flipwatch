import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkerSection, type WorkerView } from "@/components/settings/worker-section";
import type { WorkerMode } from "@/lib/config";
import { heartbeatStatus } from "@/lib/queries/settings";

const NOW = new Date("2026-09-28T12:00:00Z");
// E.g. written by `npm run db:seed`, or by the inline scheduler before WORKER_MODE was switched to off.
const oldBeat = { at: new Date(NOW.getTime() - 26 * 60_000), pid: 7533, mode: "seed" };

const render = (mode: WorkerMode) => {
  const worker: WorkerView = { mode, status: heartbeatStatus(oldBeat, mode, NOW), heartbeatAt: oldBeat.at.toISOString(), pid: oldBeat.pid };
  return renderToStaticMarkup(createElement(WorkerSection, { worker, runs: [] }));
};

describe("Settings worker status", () => {
  it("is Off, not Stalled, when polling is off here and the last beat is old", () => {
    const html = render("off");
    expect(html).toContain(">Off</span>");
    expect(html).not.toContain("Stalled");
    expect(html).not.toContain("check the worker logs");
  });

  it("still warns when an inline or external worker stops beating", () => {
    for (const mode of ["inline", "external"] as const) {
      const html = render(mode);
      expect(html).toContain(">Stalled</span>");
      expect(html).toContain("check the worker logs");
    }
  });
});
