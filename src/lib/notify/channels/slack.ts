import { NotifyError, requireConfig, requireHttpUrl } from "../errors";
import { escapeSlack, fitLines, fitRendered, slackLinkUrl, truncate } from "../escape";
import { post, type HttpRequest } from "../http";
import type { Alert, ChannelSender, SendContext } from "../types";

// https://api.slack.com/reference/block-kit/blocks
const SECTION_TEXT_MAX = 3000;
const BUTTON_TEXT_MAX = 75;

type SlackText = { type: "mrkdwn" | "plain_text"; text: string };
type SlackBlock =
  | { type: "section"; text: SlackText; accessory?: { type: "image"; image_url: string; alt_text: string } }
  | { type: "context"; elements: SlackText[] }
  | { type: "actions"; elements: Array<{ type: "button"; text: SlackText; url: string; action_id: string; style?: "primary" }> };

export interface SlackPayload {
  text: string;
  blocks: SlackBlock[];
  unfurl_links: false;
  unfurl_media: false;
}

function link(url: string, label: string): string {
  return `<${slackLinkUrl(url)}|${escapeSlack(label)}>`;
}

function sectionText(alert: Alert): string {
  const heading = `*${link(alert.url, truncate(alert.title, 200))}*`;
  const room = SECTION_TEXT_MAX - heading.length - 1;
  if (alert.kind === "digest") {
    const shown = alert.items.slice(0, 10);
    const lines = shown.map((item) => `• ${link(item.url ?? item.appUrl, truncate(item.title, 150))}`);
    if (alert.items.length > shown.length) lines.push(`…and ${alert.items.length - shown.length} more`);
    return [heading, fitRendered(lines, room)].filter(Boolean).join("\n");
  }
  const body = fitLines(alert.fields.map((f) => `${f.label}: ${f.value}`), room, escapeSlack);
  return [heading, body].filter(Boolean).join("\n");
}

function button(label: string, url: string, actionId: string, primary = false) {
  return {
    type: "button" as const,
    text: { type: "plain_text" as const, text: truncate(label, BUTTON_TEXT_MAX) },
    url,
    action_id: actionId,
    ...(primary ? { style: "primary" as const } : {}),
  };
}

export function buildSlackPayload(alert: Alert, opts: { includeImage?: boolean } = {}): SlackPayload {
  const section: SlackBlock = { type: "section", text: { type: "mrkdwn", text: sectionText(alert) } };
  if (alert.imageUrl && opts.includeImage !== false) {
    section.accessory = { type: "image", image_url: alert.imageUrl, alt_text: truncate(alert.title, 2000) };
  }
  const contextText = [alert.context, alert.test ? "FlipWatch test alert" : "via FlipWatch"].filter(Boolean).join(" · ");
  const buttons =
    alert.kind === "digest" || alert.url === alert.appUrl
      ? [button("Open in FlipWatch", alert.appUrl, "open_app", true)]
      : [button("Open listing", alert.url, "open_listing", true), button("Open in FlipWatch", alert.appUrl, "open_app")];

  return {
    // Fallback for notifications and clients without Block Kit; mrkdwn-escaped like the blocks.
    text: escapeSlack(truncate(alert.title, 300)),
    blocks: [
      section,
      { type: "context", elements: [{ type: "mrkdwn", text: fitLines([contextText], SECTION_TEXT_MAX, escapeSlack) }] },
      { type: "actions", elements: buttons },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

export function buildSlackRequest(alert: Alert, config: Record<string, string>, opts: { includeImage?: boolean } = {}): HttpRequest {
  const webhookUrl = requireHttpUrl(requireConfig(config, "webhookUrl", "webhook URL"), "Webhook URL");
  return {
    url: webhookUrl.toString(),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildSlackPayload(alert, opts)),
  };
}

export const sendSlack: ChannelSender = async (alert, config, ctx: SendContext) => {
  try {
    await post(buildSlackRequest(alert, config), ctx, { service: "Slack", retryOn429: true });
  } catch (err) {
    // Slack rejects the whole message (400 invalid_blocks) when it can't download the image
    // accessory — common with expiring marketplace CDN links. Retry once without it.
    if (!(alert.imageUrl && err instanceof NotifyError && err.status === 400)) throw err;
    await post(buildSlackRequest(alert, config, { includeImage: false }), ctx, { service: "Slack", retryOn429: true });
  }
};
