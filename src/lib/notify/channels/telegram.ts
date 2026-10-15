import { ChannelNotConfiguredError, NotifyError, requireConfig } from "../errors";
import { escapeHtml, fitLines, fitRendered, truncate } from "../escape";
import { post, type HttpRequest } from "../http";
import type { Alert, ChannelSender } from "../types";

// Telegram counts these limits on the visible text after entity parsing; the escaped length is an upper bound.
const CAPTION_MAX = 1024;
const MESSAGE_MAX = 4096;
const API_BASE = "https://api.telegram.org";

type InlineButton = { text: string; url: string };

/**
 * Telegram rejects inline-keyboard/link URLs it considers invalid (localhost, bare hostnames, private
 * IPs) with a 400 that would fail the whole message, so such buttons are left out.
 */
export function isTelegramLinkUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[")) return false;
  if (/(^|\.)(localhost|local|internal|lan|home)$/.test(host)) return false;
  return !/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

function keyboard(alert: Alert): { inline_keyboard: InlineButton[][] } | undefined {
  const buttons: InlineButton[] = [];
  if (alert.kind !== "digest" && alert.url !== alert.appUrl) buttons.push({ text: "Open listing", url: alert.url });
  buttons.push({ text: "FlipWatch", url: alert.appUrl });
  const usable = buttons.filter((b) => isTelegramLinkUrl(b.url));
  return usable.length ? { inline_keyboard: [usable] } : undefined;
}

/** Escaped link text, wrapped in <a> only when Telegram will accept the URL. */
function htmlLink(url: string, text: string): string {
  return isTelegramLinkUrl(url) ? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>` : escapeHtml(text);
}

/** HTML body (parse_mode=HTML): linked bold title, then escaped detail lines. */
export function telegramHtml(alert: Alert, max: number): string {
  const heading = `<b>${htmlLink(alert.url, truncate(alert.title, 200))}</b>`;
  const room = max - heading.length - 1;
  let body: string;
  if (alert.kind === "digest") {
    const shown = alert.items.slice(0, 10);
    const lines = shown.map((item) => `• ${htmlLink(item.url ?? item.appUrl, truncate(item.title, 150))}`);
    if (alert.items.length > shown.length) lines.push(escapeHtml(`…and ${alert.items.length - shown.length} more`));
    body = fitRendered(lines, room);
  } else {
    body = fitLines(alert.lines, room, escapeHtml);
  }
  return body ? `${heading}\n${body}` : heading;
}

interface TelegramConfig {
  token: string;
  chatId: string;
}

function telegramConfig(config: Record<string, string>): TelegramConfig {
  const token = requireConfig(config, "botToken", "bot token");
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new ChannelNotConfiguredError("Bot token should look like 123456:ABC-DEF…");
  const chatId = requireConfig(config, "chatId", "chat ID");
  if (!/^(-?\d+|@[A-Za-z0-9_]{4,})$/.test(chatId)) throw new ChannelNotConfiguredError("Chat ID should be a number (or @channelname)");
  return { token, chatId };
}

export function buildTelegramRequest(alert: Alert, config: Record<string, string>, opts: { photo?: boolean } = {}): HttpRequest {
  const { token, chatId } = telegramConfig(config);
  const usePhoto = opts.photo !== false && alert.imageUrl !== null;
  const payload: Record<string, unknown> = { chat_id: chatId, parse_mode: "HTML" };
  const markup = keyboard(alert);
  if (markup) payload.reply_markup = markup;
  if (usePhoto) {
    payload.photo = alert.imageUrl;
    payload.caption = telegramHtml(alert, CAPTION_MAX);
  } else {
    payload.text = telegramHtml(alert, MESSAGE_MAX);
    payload.link_preview_options = { is_disabled: alert.kind === "digest" };
  }
  return {
    url: `${API_BASE}/bot${token}/${usePhoto ? "sendPhoto" : "sendMessage"}`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export const sendTelegram: ChannelSender = async (alert, config, ctx) => {
  if (!alert.imageUrl) {
    await post(buildTelegramRequest(alert, config, { photo: false }), ctx, { service: "Telegram", retryOn429: true });
    return;
  }
  try {
    await post(buildTelegramRequest(alert, config), ctx, { service: "Telegram", retryOn429: true });
  } catch (err) {
    // 400 from sendPhoto usually means Telegram couldn't fetch/parse the image; send it as text instead.
    if (!(err instanceof NotifyError && err.status === 400)) throw err;
    await post(buildTelegramRequest(alert, config, { photo: false }), ctx, { service: "Telegram", retryOn429: true });
  }
};
