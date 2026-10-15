import { describe, expect, it } from "vitest";
import { guardRequest, isAllowedHost } from "./request-guard";

const cfg = { appUrl: "https://flipwatch.tail123.ts.net", allowedHosts: "192.168.1.50:3000, nas.local" };
const req = (over: Partial<Parameters<typeof guardRequest>[0]>) => ({ method: "GET", host: "127.0.0.1:3000", origin: null, secFetchSite: null, ...over });

describe("request guard", () => {
  it("answers FlipWatch's own addresses only (DNS rebinding)", () => {
    for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "LOCALHOST", "flipwatch.tail123.ts.net", "192.168.1.50:3000", "nas.local:8080"]) {
      expect(isAllowedHost(host, cfg), host).toBe(true);
    }
    for (const host of ["evil.example:3000", "127.0.0.1.evil.example", "flipwatch.tail123.ts.net.evil.example", "192.168.1.51:3000", "", null]) {
      expect(isAllowedHost(host, cfg), String(host)).toBe(false);
    }
    expect(guardRequest(req({ host: "evil.example:3000" }), cfg)).toMatchObject({ ok: false, status: 421 });
    expect(guardRequest(req({}), cfg)).toEqual({ ok: true });
  });

  it("refuses changes coming from other websites, but not from FlipWatch itself or tools without an Origin", () => {
    expect(guardRequest(req({ method: "POST", origin: "https://evil.example" }), cfg)).toMatchObject({ ok: false, status: 403 });
    expect(guardRequest(req({ method: "POST", origin: "null" }), cfg)).toMatchObject({ ok: false, status: 403 });
    expect(guardRequest(req({ method: "POST", secFetchSite: "cross-site" }), cfg)).toMatchObject({ ok: false, status: 403 });
    expect(guardRequest(req({ method: "POST", origin: "http://127.0.0.1:3000", secFetchSite: "same-origin" }), cfg)).toEqual({ ok: true });
    expect(guardRequest(req({ method: "POST", host: "flipwatch.tail123.ts.net", origin: "https://flipwatch.tail123.ts.net" }), cfg)).toEqual({ ok: true });
    // curl / cron jobs send no Origin.
    expect(guardRequest(req({ method: "POST" }), cfg)).toEqual({ ok: true });
    // Reading is fine cross-site (the browser keeps the response from the other site).
    expect(guardRequest(req({ method: "GET", origin: "https://evil.example" }), cfg)).toEqual({ ok: true });
  });
});
