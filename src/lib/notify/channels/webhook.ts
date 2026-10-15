import { createHmac } from "node:crypto";
import { requireConfig, requireHttpUrl } from "../errors";
import { post, type HttpRequest } from "../http";
import type { Alert, ChannelSender } from "../types";

export const SIGNATURE_HEADER = "X-FlipWatch-Signature";

/** Stable JSON contract for custom webhooks. Add fields; never rename or remove them. */
export function buildWebhookPayload(alert: Alert, sentAt: Date = new Date()) {
  return {
    event: alert.kind,
    test: alert.test,
    sentAt: sentAt.toISOString(),
    title: alert.title,
    search: alert.search,
    listing: alert.listing,
    match: alert.match,
    ai: alert.ai,
    /** Listings bundled in a digest (empty for single-listing events). */
    matches: alert.items,
    links: {
      listing: alert.listing?.url ?? null,
      app: alert.appUrl,
    },
  };
}

/** `sha256=<hex HMAC-SHA256 of the exact request body>`, GitHub-style. */
export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function buildWebhookRequest(alert: Alert, config: Record<string, string>, sentAt: Date = new Date()): HttpRequest {
  const url = requireHttpUrl(requireConfig(config, "url", "URL"), "URL");
  const body = JSON.stringify(buildWebhookPayload(alert, sentAt));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "FlipWatch-Webhook/1",
    "X-FlipWatch-Event": alert.kind,
  };
  const secret = config.secret;
  if (secret) headers[SIGNATURE_HEADER] = signWebhookBody(body, secret);
  return { url: url.toString(), headers, body };
}

export const sendWebhook: ChannelSender = async (alert, config, ctx) => {
  await post(buildWebhookRequest(alert, config), ctx, { service: "Webhook" });
};
