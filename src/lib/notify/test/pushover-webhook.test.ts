import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PUSHOVER_URL, buildPushoverRequest, sendPushover } from "../channels/pushover";
import { SIGNATURE_HEADER, buildWebhookPayload, buildWebhookRequest, sendWebhook, signWebhookBody } from "../channels/webhook";
import { APP_URL, HOSTILE_TITLE, NOW, jsonResponse, makeAlert, makeCtx, makeDigestAlert, stubFetch } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

const PUSHOVER = { userKey: "u".repeat(30), appToken: "a".repeat(30) };

describe("pushover", () => {
  it("posts a form with escaped HTML message, plain title, url and priority", () => {
    const req = buildPushoverRequest(makeAlert({ lines: [HOSTILE_TITLE, "Est. profit: +$95"] }), PUSHOVER);
    expect(req.url).toBe(PUSHOVER_URL);
    expect(req.headers).toEqual({ "Content-Type": "application/x-www-form-urlencoded" });
    const form = Object.fromEntries(req.body as URLSearchParams);
    expect(form).toMatchObject({
      token: PUSHOVER.appToken,
      user: PUSHOVER.userKey,
      title: `$120 · ${HOSTILE_TITLE}`,
      message: "&lt;b&gt;x&lt;/b&gt; &amp; *y* @everyone\nEst. profit: +$95",
      html: "1",
      priority: "1",
      url: "https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html",
      url_title: "Open listing",
      timestamp: String(NOW.getTime() / 1000),
    });
  });

  it("uses normal priority below a deal score of 80 and caps lengths", () => {
    const form = Object.fromEntries(
      buildPushoverRequest(makeAlert({ dealScore: 79, title: "t".repeat(400), lines: ["&".repeat(2000)] }), PUSHOVER).body as URLSearchParams,
    );
    expect(form.priority).toBe("0");
    expect(form.title.length).toBeLessThanOrEqual(250);
    expect(form.message.length).toBeLessThanOrEqual(1024);
  });

  it("links digests to FlipWatch", () => {
    const form = Object.fromEntries(buildPushoverRequest(makeDigestAlert(3), PUSHOVER).body as URLSearchParams);
    expect(form.url).toBe(`${APP_URL}/?search=3`);
    expect(form.url_title).toBe("Open in FlipWatch");
    expect(form.message).toContain('• <a href="https://vancouver.craigslist.org/van/vgm/d/ps5/0.html">');
  });

  it("rejects malformed keys and reports API errors", async () => {
    expect(() => buildPushoverRequest(makeAlert(), { userKey: "short", appToken: "a".repeat(30) })).toThrow(/User key/);
    stubFetch(() => jsonResponse(400, { status: 0, errors: ["application token is invalid"] }));
    await expect(sendPushover(makeAlert(), PUSHOVER, makeCtx())).rejects.toThrow("Pushover returned HTTP 400: application token is invalid");
  });
});

describe("webhook", () => {
  it("posts the JSON contract", () => {
    const alert = makeAlert({
      listing: {
        id: 42,
        marketplace: "craigslist",
        externalId: "7712345678",
        title: HOSTILE_TITLE,
        url: "https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html",
        priceCents: 12_000,
        previousPriceCents: null,
        originalPriceCents: 12_000,
        currency: "USD",
        locationText: "Vancouver",
        postedAt: NOW.toISOString(),
        imageUrls: [],
        sellerName: null,
        condition: null,
      },
    });
    const req = buildWebhookRequest(alert, { url: "https://example.com/hooks/flipwatch" }, NOW);
    expect(req.url).toBe("https://example.com/hooks/flipwatch");
    expect(req.headers).toMatchObject({ "Content-Type": "application/json", "X-FlipWatch-Event": "new" });
    expect(req.headers).not.toHaveProperty(SIGNATURE_HEADER);
    const body = JSON.parse(req.body as string);
    expect(body).toMatchObject({
      event: "new",
      test: false,
      sentAt: NOW.toISOString(),
      search: { id: 3, name: "PS5" },
      listing: { id: 42, title: HOSTILE_TITLE, priceCents: 12_000 },
      matches: [],
      links: { listing: "https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html", app: `${APP_URL}/listings/42` },
    });
  });

  it("signs the exact body with HMAC-SHA256 when a secret is set", async () => {
    const secret = "s3cr3t";
    const req = buildWebhookRequest(makeAlert(), { url: "https://example.com/h", secret }, NOW);
    const expected = `sha256=${createHmac("sha256", secret).update(req.body as string).digest("hex")}`;
    expect(req.headers?.[SIGNATURE_HEADER]).toBe(expected);
    expect(signWebhookBody("{}", "k")).toBe("sha256=" + createHmac("sha256", "k").update("{}").digest("hex"));

    // What actually goes over the wire verifies too.
    const { calls } = stubFetch(() => new Response("ok"));
    await sendWebhook(makeAlert(), { url: "https://example.com/h", secret }, makeCtx());
    const sent = calls[0];
    const signature = (sent.init.headers as Record<string, string>)[SIGNATURE_HEADER];
    expect(signature).toBe(`sha256=${createHmac("sha256", secret).update(sent.init.body as string).digest("hex")}`);
  });

  it("describes digests with their bundled matches", () => {
    const payload = buildWebhookPayload(makeDigestAlert(2), NOW);
    expect(payload.event).toBe("digest");
    expect(payload.listing).toBeNull();
    expect(payload.matches.map((m) => m.matchId)).toEqual([100, 101]);
    expect(payload.links.app).toBe(`${APP_URL}/?search=3`);
  });

  it("refuses to follow redirects that would turn the POST into a GET", async () => {
    const { calls } = stubFetch(() => new Response(null, { status: 301, headers: { Location: "https://example.com/new" } }));
    const err = await sendWebhook(makeAlert(), { url: "http://example.com/h" }, makeCtx()).catch((e) => e);
    expect(calls[0].init.redirect).toBe("manual");
    expect(err.message).toBe("Webhook URL redirects (HTTP 301); use the final URL");
    expect(err.permanent).toBe(true);
  });

  it("does not retry 429 and treats 5xx as transient", async () => {
    const { calls } = stubFetch(() => new Response("busy", { status: 503 }));
    const err = await sendWebhook(makeAlert(), { url: "https://example.com/h" }, makeCtx()).catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err.permanent).toBe(false);
    expect(err.message).toBe("Webhook returned HTTP 503: busy");
  });
});
