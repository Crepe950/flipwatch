import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSlackPayload, buildSlackRequest, sendSlack } from "../channels/slack";
import { makeAlert, makeCtx, makeDigestAlert, stubFetch } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret";

describe("slack", () => {
  it("builds blocks with an escaped mrkdwn section, image accessory, context and buttons", () => {
    const req = buildSlackRequest(makeAlert(), { webhookUrl: WEBHOOK });
    expect(req.url).toBe(WEBHOOK);
    const payload = JSON.parse(req.body as string);
    expect(payload.text).toBe("$120 · &lt;b&gt;x&lt;/b&gt; &amp; *y* @everyone");
    const [section, context, actions] = payload.blocks;
    expect(section.text.type).toBe("mrkdwn");
    expect(section.text.text).toContain(
      "*<https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html|$120 · &lt;b&gt;x&lt;/b&gt; &amp; *y* @everyone>*",
    );
    expect(section.text.text).toContain("Deal score: 86/100");
    expect(section.accessory).toMatchObject({ type: "image", image_url: "https://images.craigslist.org/00a0a_abc_600x450.jpg" });
    expect(context).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "Craigslist · Vancouver, BC · posted 5m ago · via FlipWatch" }] });
    expect(actions.elements.map((b: { url: string }) => b.url)).toEqual([
      "https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html",
      "https://flipwatch.example.com/listings/42",
    ]);
  });

  it("keeps hostile field text from forming links or mentions", () => {
    const payload = buildSlackPayload(makeAlert({ fields: [{ label: "AI verdict", value: "<!channel> <https://evil.example|click>" }] }));
    const text = (payload.blocks[0] as { text: { text: string } }).text.text;
    expect(text).toContain("AI verdict: &lt;!channel&gt; &lt;https://evil.example|click&gt;");
    expect(text).not.toContain("<!channel>");
  });

  it("truncates the section to Slack's 3000 character limit", () => {
    const payload = buildSlackPayload(makeAlert({ fields: [{ label: "AI verdict", value: "&".repeat(5000) }] }));
    const text = (payload.blocks[0] as { text: { text: string } }).text.text;
    expect(text.length).toBeLessThanOrEqual(3000);
    expect(text).not.toMatch(/&(a|am|amp)?…$/);
  });

  it("links digest items and offers a single FlipWatch button", () => {
    const payload = buildSlackPayload(makeDigestAlert(3));
    const text = (payload.blocks[0] as { text: { text: string } }).text.text;
    expect(text).toContain("• <https://vancouver.craigslist.org/van/vgm/d/ps5/0.html|$100 · PS5 #0 &lt;b&gt;x&lt;/b&gt; &amp; *y* @everyone>");
    const actions = payload.blocks[2] as { elements: Array<{ url: string }> };
    expect(actions.elements).toHaveLength(1);
    expect(actions.elements[0].url).toBe("https://flipwatch.example.com/?search=3");
  });

  it("retries without the image when Slack rejects the blocks", async () => {
    const { calls } = stubFetch((_u, _i, n) => (n === 1 ? new Response("invalid_blocks", { status: 400 }) : new Response("ok", { status: 200 })));
    await sendSlack(makeAlert(), { webhookUrl: WEBHOOK }, makeCtx());
    expect(calls).toHaveLength(2);
    expect(calls[0].json.blocks).toBeDefined();
    expect((calls[1].json.blocks as Array<{ accessory?: unknown }>)[0].accessory).toBeUndefined();
  });

  it("respects Retry-After once on 429", async () => {
    const sleep = vi.fn(async () => {});
    const { calls } = stubFetch((_u, _i, n) =>
      n === 1 ? new Response("rate_limited", { status: 429, headers: { "Retry-After": "2" } }) : new Response("ok", { status: 200 }),
    );
    await sendSlack(makeAlert({ imageUrl: null }), { webhookUrl: WEBHOOK }, makeCtx({ sleep }));
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000, expect.anything());
  });
});
