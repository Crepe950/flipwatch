import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNtfyRequest, ntfyPriority, sendNtfy } from "../channels/ntfy";
import { ChannelNotConfiguredError, NotifyError } from "../errors";
import { HOSTILE_TITLE, makeAlert, makeCtx, makeDigestAlert, stubFetch } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

describe("ntfy", () => {
  it("publishes through the JSON API at the server root", () => {
    const req = buildNtfyRequest(makeAlert(), { topic: "flipwatch-7f3k2q" });
    expect(req.url).toBe("https://ntfy.sh/");
    expect(req.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(req.body as string);
    expect(body).toMatchObject({
      topic: "flipwatch-7f3k2q",
      title: `$120 · ${HOSTILE_TITLE}`,
      click: "https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html",
      attach: "https://images.craigslist.org/00a0a_abc_600x450.jpg",
      priority: 5,
      tags: ["moneybag", "fire"],
      actions: [{ action: "view", label: "Open in FlipWatch", url: "https://flipwatch.example.com/listings/42", clear: true }],
    });
    expect(body.message).toContain("Deal score: 86/100");
  });

  it("keeps listing text out of HTTP headers (non-ASCII safe) and adds the bearer token", () => {
    const req = buildNtfyRequest(makeAlert({ title: "Café ☕ – 50 €" }), { topic: "t", server: "https://ntfy.example.com/sub/", token: "tk_abc" });
    expect(req.url).toBe("https://ntfy.example.com/sub/");
    expect(req.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer tk_abc" });
    expect(JSON.parse(req.body as string).title).toBe("Café ☕ – 50 €");
  });

  it("sets priority 5 for hot deals, 4 for price drops, else 3", () => {
    expect(ntfyPriority(makeAlert({ dealScore: 80 }))).toBe(5);
    expect(ntfyPriority(makeAlert({ kind: "price_drop", dealScore: 50 }))).toBe(4);
    expect(ntfyPriority(makeAlert({ dealScore: null }))).toBe(3);
    expect(ntfyPriority(makeDigestAlert())).toBe(3);
    const drop = JSON.parse(buildNtfyRequest(makeAlert({ kind: "price_drop", dealScore: 10 }), { topic: "t" }).body as string);
    expect(drop.tags).toEqual(["chart_with_downwards_trend"]);
  });

  it("omits attach without an image", () => {
    const body = JSON.parse(buildNtfyRequest(makeAlert({ imageUrl: null }), { topic: "t" }).body as string);
    expect(body).not.toHaveProperty("attach");
  });

  it("rejects missing or malformed config", () => {
    expect(() => buildNtfyRequest(makeAlert(), {})).toThrow(ChannelNotConfiguredError);
    expect(() => buildNtfyRequest(makeAlert(), { topic: "has space" })).toThrow(/Topic/);
    expect(() => buildNtfyRequest(makeAlert(), { topic: "t", server: "ftp://x" })).toThrow(/https/);
  });

  it("sends and surfaces HTTP errors without leaking the URL", async () => {
    const { calls } = stubFetch(() => new Response('{"error":"unauthorized"}', { status: 401 }));
    const err = await sendNtfy(makeAlert(), { topic: "secret-topic" }, makeCtx()).catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(NotifyError);
    expect(err.message).toBe("ntfy returned HTTP 401: unauthorized");
    expect(err.permanent).toBe(true);
    expect(err.message).not.toContain("secret-topic");
  });
});
