import { describe, expect, it } from "vitest";
import { buildGeometry, nearestStep, niceTicks, toSteps } from "@/components/listing/price-chart-model";
import { safeHttpUrl, safeImageUrl } from "@/components/listing/safe-url";

describe("safe URLs for untrusted marketplace data", () => {
  it("allows http(s) and protocol-relative links", () => {
    expect(safeHttpUrl("https://vancouver.craigslist.org/x/1.html")).toBe("https://vancouver.craigslist.org/x/1.html");
    expect(safeHttpUrl("  http://example.org/a b ")).toBe("http://example.org/a%20b");
    expect(safeHttpUrl("//images.craigslist.org/a.jpg")).toBe("https://images.craigslist.org/a.jpg");
  });

  it("blocks script and non-web schemes and garbage", () => {
    for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>", "vbscript:x", "file:///etc/passwd", "not a url", "", null, undefined]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });

  it("allows inline image data URIs for photos only", () => {
    expect(safeImageUrl("data:image/svg+xml;charset=utf-8,%3Csvg%3E")).toMatch(/^data:image\/svg\+xml/);
    expect(safeImageUrl("data:image/png;base64,AAAA")).toMatch(/^data:image\/png/);
    expect(safeImageUrl("data:text/html;base64,AAAA")).toBeNull();
    expect(safeHttpUrl("data:image/png;base64,AAAA")).toBeNull();
  });
});

describe("price chart model", () => {
  const t = (h: number) => Date.UTC(2026, 8, 28, h);

  it("collapses repeated observations into steps and records changes", () => {
    const steps = toSteps(
      [
        { t: t(3), priceCents: 40000 },
        { t: t(0), priceCents: 45000 },
        { t: t(1), priceCents: 45000 },
        { t: t(5), priceCents: null },
        { t: t(6), priceCents: 36000 },
      ],
      t(8),
    );
    expect(steps).toEqual([
      { start: t(0), end: t(3), priceCents: 45000, changeCents: null },
      { start: t(3), end: t(5), priceCents: 40000, changeCents: -5000 },
      { start: t(5), end: t(6), priceCents: null, changeCents: null },
      { start: t(6), end: t(8), priceCents: 36000, changeCents: -4000 },
    ]);
    expect(toSteps([], t(1))).toEqual([]);
  });

  it("never ends a step before it starts", () => {
    expect(toSteps([{ t: t(5), priceCents: 100 }], t(1))[0].end).toBe(t(5));
  });

  it("produces nice, non-negative ticks, also for a flat series", () => {
    expect(niceTicks(36000, 45000)).toEqual({ lo: 35000, hi: 45000, ticks: [35000, 40000, 45000] });
    const flat = niceTicks(33000, 33000);
    expect(flat.lo).toBeLessThan(33000);
    expect(flat.hi).toBeGreaterThan(33000);
    expect(niceTicks(0, 500).lo).toBe(0);
  });

  it("builds step paths with gaps for unknown prices", () => {
    const steps = toSteps(
      [
        { t: t(0), priceCents: 45000 },
        { t: t(2), priceCents: null },
        { t: t(4), priceCents: 40000 },
      ],
      t(6),
    );
    const g = buildGeometry(steps, { width: 400, height: 200, left: 50, right: 10, top: 10, bottom: 30 })!;
    expect(g.line.match(/M/g)).toHaveLength(2);
    expect(g.area.match(/Z/g)).toHaveLength(2);
    expect(g.x(t(0))).toBe(50);
    expect(g.x(t(6))).toBe(390);
    expect(buildGeometry(toSteps([{ t: t(0), priceCents: null }], t(1)), { width: 400, height: 200, left: 0, right: 0, top: 0, bottom: 0 })).toBeNull();
  });

  it("snaps the crosshair to the nearest price change", () => {
    const steps = toSteps(
      [
        { t: t(0), priceCents: 1 },
        { t: t(4), priceCents: 2 },
        { t: t(10), priceCents: 3 },
      ],
      t(12),
    );
    expect(nearestStep(steps, t(1))).toBe(0);
    expect(nearestStep(steps, t(3))).toBe(1);
    expect(nearestStep(steps, t(11))).toBe(2);
  });
});
