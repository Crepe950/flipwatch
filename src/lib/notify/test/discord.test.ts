import { afterEach, describe, expect, it, vi } from "vitest";
import { DISCORD_LIMITS, buildDiscordBotRequest, buildDiscordEmbed, buildDiscordRequest, sendDiscord } from "../channels/discord";
import { NotifyError } from "../errors";
import { jsonResponse, makeAlert, makeCtx, makeDigestAlert, stubFetch } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

const WEBHOOK = "https://discord.com/api/webhooks/123/secret-token";

describe("discord", () => {
  it("builds an embed with escaped markdown, fields, image and no mentions", () => {
    const req = buildDiscordRequest(makeAlert(), { webhookUrl: WEBHOOK });
    expect(req.url).toBe(WEBHOOK);
    const body = JSON.parse(req.body as string);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const [embed] = body.embeds;
    expect(embed.title).toBe("$120 · \\<b\\>x\\</b\\> & \\*y\\* \\@everyone");
    expect(embed.url).toBe("https://vancouver.craigslist.org/van/vgm/d/ps5/7712345678.html");
    expect(embed.image).toEqual({ url: "https://images.craigslist.org/00a0a_abc_600x450.jpg" });
    expect(embed.color).toBe(0x0f9d58);
    expect(embed.timestamp).toBe("2026-09-28T12:00:00.000Z");
    expect(embed.footer).toEqual({ text: "FlipWatch" });
    expect(embed.description).toContain("[Open in FlipWatch](https://flipwatch.example.com/listings/42)");
    expect(embed.fields).toContainEqual({ name: "Deal score", value: "86/100 · 32% below median of 14 comps", inline: true });
  });

  it("posts the same embed through the bot into a channel by id", () => {
    const req = buildDiscordBotRequest(makeAlert(), { channelId: "123456789012345678" }, "bot-token");
    expect(req.url).toBe("https://discord.com/api/v10/channels/123456789012345678/messages");
    expect(req.headers).toMatchObject({ Authorization: "Bot bot-token" });
    const body = JSON.parse(req.body as string);
    expect(body).toEqual({ embeds: [buildDiscordEmbed(makeAlert())], allowed_mentions: { parse: [] } });

    expect(() => buildDiscordBotRequest(makeAlert(), { channelId: "../../users/@me" }, "bot-token")).toThrow(/numeric ID/);
    expect(() => buildDiscordBotRequest(makeAlert(), { channelId: "123456789012345678" }, undefined)).toThrow(/DISCORD_BOT_TOKEN/);
  });

  it("escapes hostile field values and context", () => {
    const embed = buildDiscordEmbed(
      makeAlert({ context: "[phish](https://evil.example)", fields: [{ label: "AI verdict", value: "Great — <@&123> **buy**" }] }),
    );
    expect(embed.description).toContain("\\[phish\\]\\(https://evil.example\\)");
    expect(embed.fields[0].value).toBe("Great — \\<\\@&123\\> \\*\\*buy\\*\\*");
  });

  it("truncates to Discord limits", () => {
    const long = "x".repeat(10_000);
    const embed = buildDiscordEmbed(makeAlert({ title: long, context: long, fields: [{ label: "AI verdict", value: long }] }));
    expect(embed.title.length).toBeLessThanOrEqual(DISCORD_LIMITS.title);
    expect(embed.title.endsWith("…")).toBe(true);
    expect(embed.fields[0].value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue);
    expect(embed.description!.length).toBeLessThanOrEqual(DISCORD_LIMITS.description);
    const total = embed.title.length + (embed.description?.length ?? 0) + embed.footer.text.length + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(DISCORD_LIMITS.total);
  });

  it("lists digest items as escaped masked links", () => {
    const embed = buildDiscordEmbed(makeDigestAlert(12));
    expect(embed.title).toBe("+12 more matches for PS5");
    expect(embed.url).toBe("https://flipwatch.example.com/?search=3");
    expect(embed.description).toContain("• [$100 · PS5 \\#0 \\<b\\>x\\</b\\> & \\*y\\* \\@everyone](https://vancouver.craigslist.org/van/vgm/d/ps5/0.html)");
    expect(embed.description).toContain("…and 2 more");
    expect(embed.image).toBeUndefined();
  });

  it("waits for retry_after once on 429, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const { calls } = stubFetch((_url, _init, n) =>
      n === 1 ? jsonResponse(429, { message: "You are being rate limited.", retry_after: 0.25, global: false }) : new Response(null, { status: 204 }),
    );
    await sendDiscord(makeAlert(), { webhookUrl: WEBHOOK }, makeCtx({ sleep }));
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(250, expect.anything());
  });

  it("fails after a second 429", async () => {
    const { calls } = stubFetch(() => jsonResponse(429, { retry_after: 0.1 }));
    const err = await sendDiscord(makeAlert(), { webhookUrl: WEBHOOK }, makeCtx()).catch((e) => e);
    expect(calls).toHaveLength(2);
    expect(err).toBeInstanceOf(NotifyError);
    expect(err.message).toMatch(/HTTP 429/);
  });

  it("fails fast when retry-after exceeds the send deadline", async () => {
    const { calls } = stubFetch(() => jsonResponse(429, { retry_after: 60 }));
    const err = await sendDiscord(makeAlert(), { webhookUrl: WEBHOOK }, makeCtx()).catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err.message).toBe("Discord rate limited (HTTP 429); retry after 60s");
  });

  it("never includes the webhook URL in errors", async () => {
    stubFetch(() => jsonResponse(404, { message: "Unknown Webhook", code: 10015 }));
    const err = await sendDiscord(makeAlert(), { webhookUrl: WEBHOOK }, makeCtx()).catch((e) => e);
    expect(err.message).toBe("Discord returned HTTP 404: Unknown Webhook");
    expect(err.message).not.toContain("secret-token");
  });
});
