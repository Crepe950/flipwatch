import { ChannelNotConfiguredError, requireConfig } from "../errors";
import { escapeHtml, fitLines, fitRendered, truncate } from "../escape";
import { post, type HttpRequest } from "../http";
import type { Alert, ChannelSender } from "../types";

export const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
// https://pushover.net/api#limits
const LIMITS = { title: 250, message: 1024, url: 512, urlTitle: 100 } as const;
const KEY_PATTERN = /^[A-Za-z0-9]{30}$/;

function message(alert: Alert): string {
  if (alert.kind === "digest") {
    const shown = alert.items.slice(0, 10);
    const lines = shown.map((item) => {
      const href = item.url && item.url.length <= LIMITS.url ? item.url : item.appUrl;
      return `• <a href="${escapeHtml(href)}">${escapeHtml(truncate(item.title, 120))}</a>`;
    });
    if (alert.items.length > shown.length) lines.push(escapeHtml(`…and ${alert.items.length - shown.length} more`));
    return fitRendered(lines, LIMITS.message);
  }
  return fitLines(alert.lines, LIMITS.message, escapeHtml);
}

export function buildPushoverRequest(alert: Alert, config: Record<string, string>): HttpRequest {
  const user = requireConfig(config, "userKey", "user key");
  const token = requireConfig(config, "appToken", "application token");
  if (!KEY_PATTERN.test(user)) throw new ChannelNotConfiguredError("User key should be 30 letters/digits");
  if (!KEY_PATTERN.test(token)) throw new ChannelNotConfiguredError("Application token should be 30 letters/digits");

  const isListing = alert.kind !== "digest" && alert.url !== alert.appUrl;
  const url = isListing && alert.url.length <= LIMITS.url ? alert.url : alert.appUrl;
  const form = new URLSearchParams({
    token,
    user,
    // Titles are plain text in Pushover; only the message body is parsed as HTML.
    title: truncate(alert.title, LIMITS.title),
    message: message(alert) || escapeHtml(truncate(alert.title, LIMITS.message)),
    html: "1",
    priority: alert.kind !== "digest" && alert.dealScore != null && alert.dealScore >= 80 ? "1" : "0",
    timestamp: String(Math.floor(alert.timestamp.getTime() / 1000)),
  });
  if (url.length <= LIMITS.url) {
    form.set("url", url);
    form.set("url_title", truncate(url === alert.appUrl ? "Open in FlipWatch" : "Open listing", LIMITS.urlTitle));
  }
  return { url: PUSHOVER_URL, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form };
}

export const sendPushover: ChannelSender = async (alert, config, ctx) => {
  await post(buildPushoverRequest(alert, config), ctx, { service: "Pushover" });
};
