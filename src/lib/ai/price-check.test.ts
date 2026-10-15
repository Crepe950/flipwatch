import { describe, expect, it } from "vitest";
import { normalizeTargetKey } from "./price-check";

describe("normalizeTargetKey", () => {
  it("finds the target key in whatever Claude wrote", () => {
    expect(normalizeTargetKey("p0")).toBe("p0");
    expect(normalizeTargetKey("Target p3")).toBe("p3");
    expect(normalizeTargetKey("P1")).toBe("p1");
    expect(normalizeTargetKey("p2 — GPU: GTX 1060")).toBe("p2");
    expect(normalizeTargetKey(" Item ")).toBe("item");
    expect(normalizeTargetKey("cpu")).toBe("cpu");
  });
});
