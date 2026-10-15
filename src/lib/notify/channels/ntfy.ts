import { ChannelNotConfiguredError, requireConfig, requireHttpUrl } from "../errors";
import { truncate } from "../escape";
import { post, type HttpRequest } from "../http";
import type { Alert, ChannelSender } from "../types";

export const NTFY_DEFAULT_SERVER = "https://ntfy.sh";
const TOPIC_PATTERN = /^[-_A-Za-z0-9]{1,64}$/;

export function ntfyPriority(alert: Alert): number {
  if (alert.kind === "digest") return 3;
  if (alert.dealScore != null && alert.dealScore >= 80) return 5;
  return alert.kind === "price_drop" ? 4 : 3;
}

function ntfyTags(alert: Alert): string[] {
  const tags = [alert.kind === "price_drop" ? "chart_with_downwards_trend" : alert.kind === "digest" ? "package" : "moneybag"];
  if (alert.kind !== "digest" && alert.dealScore != null && alert.dealScore >= 80) tags.push("fire");
  if (alert.test) tags.push("test_tube");
  return tags;
}

/**
 * ntfy's JSON publish API (POST to the server root). Unlike the header API it carries non-ASCII
 * titles/messages safely, so listing text never ends up in HTTP headers.
 */
export function buildNtfyRequest(alert: Alert, config: Record<string, string>): HttpRequest {
  const topic = requireConfig(config, "topic", "topic");
  if (!TOPIC_PATTERN.test(topic)) {
    throw new ChannelNotConfiguredError("Topic may only contain letters, numbers, - and _ (max 64)");
  }
  const server = requireHttpUrl(config.server?.trim() || NTFY_DEFAULT_SERVER, "Server URL");
  const url = `${server.origin}${server.pathname.replace(/\/+$/, "")}/`;

  const body: Record<string, unknown> = {
    topic,
    title: truncate(alert.title, 250),
    message: truncate(alert.lines.join("\n"), 3000),
    click: alert.url,
    tags: ntfyTags(alert),
    priority: ntfyPriority(alert),
    actions: [{ action: "view", label: "Open in FlipWatch", url: alert.appUrl, clear: true }],
  };
  if (alert.imageUrl) body.attach = alert.imageUrl;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = config.token?.trim();
  if (token) {
    if (!/^[\x21-\x7e]+$/.test(token)) throw new ChannelNotConfiguredError("Access token contains invalid characters");
    headers.Authorization = `Bearer ${token}`;
  }
  return { url, headers, body: JSON.stringify(body) };
}

export const sendNtfy: ChannelSender = async (alert, config, ctx) => {
  await post(buildNtfyRequest(alert, config), ctx, { service: "ntfy" });
};
