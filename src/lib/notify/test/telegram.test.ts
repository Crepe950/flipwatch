import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTelegramRequest, isTelegramLinkUrl, sendTelegram, telegramHtml } from "../channels/telegram";
import { ChannelNotConfiguredError } from "../errors";
import { APP_URL, jsonResponse, makeAlert, makeCtx, makeDigestAlert, stubFetch } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

const CONFIG = { botToken: "123456:ABC-DEF_ghi", chatId: "-1001234567" };

describe("telegram", () => {
  it("uses sendPhoto with an escaped HTML caption and inline keyboard when there is an image", () => {
    const req = buildTelegramRequest(makeAlert(), CONFIG);
    expect(req.url).toBe("https://api.telegram.org/bot123456:ABC-DEF_ghi/sendPhoto");
    const body = JSON.parse(req.body as string);
    expect(body).toMatchObject({ chat_id: "-1001234567", parse_mode: "HTML", photo: "https://images.craigslist.org/00a0a_abc_600x450.jpg" });
    expect(body.caption).toContain(
      '<b><a href="https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html">$120 · &lt;b&gt;x&lt;/b&gt; &amp; *y* @everyone</a></b>',
    );
    expect(body.caption).not.toContain("<b>x</b>");
    expect(body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Open listing", url: "https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html" },
          { text: "FlipWatch", url: `${APP_URL}/listings/42` },
        ],
      ],
    });
  });

  it("uses sendMessage without an image", () => {
    const req = buildTelegramRequest(makeAlert({ imageUrl: null }), CONFIG);
    expect(req.url).toMatch(/\/sendMessage$/);
    const body = JSON.parse(req.body as string);
    expect(body.text).toContain("Deal score: 86/100");
    expect(body).not.toHaveProperty("photo");
  });

  it("caps captions at 1024 characters without breaking entities", () => {
    const html = telegramHtml(makeAlert({ lines: ["<&>".repeat(1000)] }), 1024);
    expect(html.length).toBeLessThanOrEqual(1024);
    expect(html).toMatch(/(&lt;|&amp;|&gt;)…$/);
  });

  it("drops buttons and links Telegram would reject (localhost app URL)", () => {
    const alert = makeAlert({ appUrl: "http://localhost:3000/listings/42", url: "http://localhost:3000/" });
    const body = JSON.parse(buildTelegramRequest(alert, CONFIG).body as string);
    expect(body).not.toHaveProperty("reply_markup");
    expect(body.caption).not.toContain("<a ");
    expect(isTelegramLinkUrl("https://flipwatch.example.com/x")).toBe(true);
    expect(isTelegramLinkUrl("http://192.168.1.5:3000/")).toBe(false);
    expect(isTelegramLinkUrl("http://flipwatch/")).toBe(false);
  });

  it("renders digests as a linked list with only the FlipWatch button", () => {
    const body = JSON.parse(buildTelegramRequest(makeDigestAlert(2), CONFIG).body as string);
    expect(body.text).toContain('• <a href="https://vancouver.craigslist.org/van/vgm/d/ps5/1.html">$101 · PS5 #1 &lt;b&gt;x&lt;/b&gt;');
    expect(body.reply_markup.inline_keyboard[0]).toEqual([{ text: "FlipWatch", url: `${APP_URL}/?search=3` }]);
  });

  it("validates the token and chat id", () => {
    expect(() => buildTelegramRequest(makeAlert(), { botToken: "nope", chatId: "1" })).toThrow(ChannelNotConfiguredError);
    expect(() => buildTelegramRequest(makeAlert(), { botToken: "1:a", chatId: "not a chat" })).toThrow(/Chat ID/);
  });

  it("falls back to sendMessage when sendPhoto fails with 400", async () => {
    const { calls } = stubFetch((url) =>
      url.endsWith("/sendPhoto")
        ? jsonResponse(400, { ok: false, error_code: 400, description: "Bad Request: wrong file identifier/HTTP URL specified" })
        : jsonResponse(200, { ok: true }),
    );
    await sendTelegram(makeAlert(), CONFIG, makeCtx());
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["sendPhoto", "sendMessage"]);
  });

  it("respects parameters.retry_after on 429 once", async () => {
    const sleep = vi.fn(async () => {});
    const { calls } = stubFetch((_u, _i, n) =>
      n === 1 ? jsonResponse(429, { ok: false, error_code: 429, parameters: { retry_after: 3 } }) : jsonResponse(200, { ok: true }),
    );
    await sendTelegram(makeAlert({ imageUrl: null }), CONFIG, makeCtx({ sleep }));
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(3000, expect.anything());
  });

  it("does not fall back on auth errors, and hides the token", async () => {
    const { calls } = stubFetch(() => jsonResponse(401, { ok: false, error_code: 401, description: "Unauthorized" }));
    const err = await sendTelegram(makeAlert(), CONFIG, makeCtx()).catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err.message).toBe("Telegram returned HTTP 401: Unauthorized");
    expect(err.message).not.toContain("ABC-DEF");
  });
});
