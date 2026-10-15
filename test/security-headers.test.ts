import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

async function headersFor(source: string): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((r) => r.source === source);
  return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key.toLowerCase(), h.value]));
}

describe("security headers", () => {
  it("applies to every path", async () => {
    const headers = await headersFor("/:path*");
    expect(headers).toMatchObject({
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
    });
  });

  it("sends a CSP that Next.js and the listing photos can live with", async () => {
    const csp = (await headersFor("/:path*"))["content-security-policy"];
    const directives = Object.fromEntries(csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values.join(" ")];
    }));
    expect(directives).toMatchObject({
      "default-src": "'self'",
      "script-src": "'self' 'unsafe-inline'",
      "img-src": "* data: blob:",
      "connect-src": "'self'",
      "object-src": "'none'",
      "frame-ancestors": "'none'",
    });
  });
});
