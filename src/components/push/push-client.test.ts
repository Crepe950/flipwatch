import { describe, expect, it } from "vitest";
import { urlBase64ToUint8Array } from "./push-client";

describe("urlBase64ToUint8Array", () => {
  it("decodes unpadded base64url VAPID keys", () => {
    const bytes = new Uint8Array(65).map((_, i) => (i * 37 + 4) % 256);
    const key = Buffer.from(bytes).toString("base64url");
    expect(key).not.toContain("=");
    expect(Array.from(urlBase64ToUint8Array(key))).toEqual(Array.from(bytes));
  });

  it("handles - and _ characters", () => {
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([0xfb, 0xff]);
  });
});
