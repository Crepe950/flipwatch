import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { withResponseTrace } from "./ebay/traced-fetch";
import { parsePriceToCents, request } from "./http";
import { BlockedError, MarketplaceError, RateLimitedError, type AdapterContext } from "./types";

describe("parsePriceToCents", () => {
  it.each([
    ["$1,234.56 obo", 123_456],
    ["£40", 4_000],
    ["CA$1,200", 120_000],
    ["1 234,50 $", 123_450],
    ["$10 - $20", 1_000],
    ["Free", 0],
    ["Please Contact", null],
    ["$", null],
    [45, 4_500],
  ] as const)("%j → %s", (input, expected) => {
    expect(parsePriceToCents(input)).toBe(expected);
  });

  it("reads a k suffix as thousands", () => {
    expect(parsePriceToCents("1.2k")).toBe(120_000);
    expect(parsePriceToCents("$1.2K")).toBe(120_000);
    expect(parsePriceToCents("15k obo")).toBe(1_500_000);
    expect(parsePriceToCents("$2 k")).toBe(200_000);
    // Only a standalone k: units that merely start with one are not a multiplier.
    expect(parsePriceToCents("2kg")).toBe(200);
  });
});

/** A response whose body records whether it was read to the end or cancelled. */
function trackedResponse(status: number, headers: Record<string, string> = {}) {
  const body = { cancelled: false, finished: false };
  let chunks = 3;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks-- > 0) controller.enqueue(new TextEncoder().encode('{"errors":[{"message":"nope"}]}'.slice(0, 10)));
      else {
        body.finished = true;
        controller.close();
      }
    },
    cancel() {
      body.cancelled = true;
    },
  });
  return { res: new Response(stream, { status, headers }), body };
}

function contextFor(res: Response): AdapterContext {
  return { fetch: (async () => res) as unknown as typeof fetch, credentials: {} };
}

describe("request() error responses", () => {
  it.each([
    [429, RateLimitedError],
    [403, BlockedError],
    [401, BlockedError],
    [404, MarketplaceError],
    [503, MarketplaceError],
  ] as const)("cancels the unread body of a %i before throwing", async (status, errorClass) => {
    const { res, body } = trackedResponse(status);
    await expect(request(contextFor(res), "kijiji", "https://example.test/")).rejects.toBeInstanceOf(errorClass);
    expect(body.cancelled).toBe(true);
  });

  it("releases the body through eBay's traced fetch too", async () => {
    const { res, body } = trackedResponse(400);
    const { ctx, trace } = withResponseTrace(contextFor(res));
    await expect(request(ctx, "ebay", "https://api.ebay.test/")).rejects.toBeInstanceOf(MarketplaceError);
    expect(trace.status).toBe(400);
    // The trace reads its clone to the end and the original is cancelled, so neither copy holds the stream.
    expect(body.finished).toBe(true);
    expect(res.bodyUsed).toBe(true);
  });

  it("leaves successful bodies for the caller", async () => {
    const { res, body } = trackedResponse(200);
    const returned = await request(contextFor(res), "kijiji", "https://example.test/");
    expect(returned).toBe(res);
    expect(body.cancelled).toBe(false);
  });

  it("does not keep a socket per failed request open", async () => {
    let open = 0;
    const server = http.createServer((_req, res) => {
      res.writeHead(429, { "content-type": "text/html" });
      res.end("x".repeat(200_000));
    });
    server.on("connection", (socket) => {
      open++;
      socket.on("close", () => open--);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const ctx: AdapterContext = { fetch: globalThis.fetch.bind(globalThis), credentials: {} };
    try {
      for (let round = 0; round < 10; round++) {
        await Promise.all(
          Array.from({ length: 5 }, () => request(ctx, "kijiji", `http://127.0.0.1:${port}/`).catch(() => undefined)),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Unreleased, most of the 50 connections stay checked out until GC; released, only the idle keep-alive pool remains.
      expect(open).toBeLessThanOrEqual(10);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
