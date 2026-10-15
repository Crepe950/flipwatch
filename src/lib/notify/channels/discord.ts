import { config as appConfig } from "../../config";
import { ChannelNotConfiguredError, requireConfig, requireHttpUrl } from "../errors";
import { escapeDiscord, fitLines, fitRendered, truncate } from "../escape";
import { post, type HttpRequest } from "../http";
import type { Alert, ChannelSender } from "../types";

// https://discord.com/developers/docs/resources/message#embed-object-embed-limits
export const DISCORD_LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, total: 6000 } as const;

const COLORS = { hot: 0x0f9d58, good: 0x34c77b, drop: 0x2b6cb0, neutral: 0x62656e } as const;

export interface DiscordEmbed {
  title: string;
  url: string;
  description?: string;
  color: number;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  image?: { url: string };
  timestamp: string;
  footer: { text: string };
}

function color(alert: Alert): number {
  if (alert.kind !== "digest" && alert.dealScore != null && alert.dealScore >= 80) return COLORS.hot;
  if (alert.kind === "price_drop" || alert.test) return COLORS.drop;
  if (alert.dealScore != null && alert.dealScore >= 60) return COLORS.good;
  return COLORS.neutral;
}

/** URL usable inside a markdown [label](url) link. */
function linkUrl(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/ /g, "%20");
}

function buildDescription(alert: Alert, budget: number): string {
  if (alert.kind === "digest") {
    const shown = alert.items.slice(0, 10);
    const lines = shown.map((item) => `• [${escapeDiscord(truncate(item.title, 150))}](${linkUrl(item.url ?? item.appUrl)})`);
    if (alert.items.length > shown.length) lines.push(escapeDiscord(`…and ${alert.items.length - shown.length} more`));
    return fitRendered(lines, budget);
  }
  const link = `[Open in FlipWatch](${linkUrl(alert.appUrl)})`;
  const context = alert.context ? fitLines([alert.context], budget - link.length - 1, escapeDiscord) : "";
  return fitRendered([context, link].filter(Boolean), budget);
}

export function buildDiscordEmbed(alert: Alert): DiscordEmbed {
  const title = fitLines([alert.title], DISCORD_LIMITS.title, escapeDiscord) || "FlipWatch alert";
  const fields = alert.fields.slice(0, 25).map((f) => {
    const value = fitLines([f.value], DISCORD_LIMITS.fieldValue, escapeDiscord) || "—";
    return { name: truncate(f.label, DISCORD_LIMITS.fieldName), value, inline: value.length <= 60 };
  });
  const footer = { text: alert.test ? "FlipWatch · test alert" : "FlipWatch" };

  const used = title.length + footer.text.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  const budget = Math.min(DISCORD_LIMITS.description, DISCORD_LIMITS.total - used);
  const description = buildDescription(alert, budget);

  const embed: DiscordEmbed = {
    title,
    url: alert.url,
    color: color(alert),
    fields,
    timestamp: alert.timestamp.toISOString(),
    footer,
  };
  if (description) embed.description = description;
  if (alert.imageUrl) embed.image = { url: alert.imageUrl };
  return embed;
}

export function buildDiscordRequest(alert: Alert, config: Record<string, string>): HttpRequest {
  const webhookUrl = requireHttpUrl(requireConfig(config, "webhookUrl", "webhook URL"), "Webhook URL");
  return {
    url: webhookUrl.toString(),
    headers: { "Content-Type": "application/json" },
    // allowed_mentions: never ping @everyone/@here/roles from listing text.
    body: JSON.stringify({ embeds: [buildDiscordEmbed(alert)], allowed_mentions: { parse: [] } }),
  };
}

export const sendDiscord: ChannelSender = async (alert, config, ctx) => {
  await post(buildDiscordRequest(alert, config), ctx, { service: "Discord", retryOn429: true });
};

/** The same embed, posted by the FlipWatch bot (DISCORD_BOT_TOKEN) into a channel by id. */
export function buildDiscordBotRequest(alert: Alert, config: Record<string, string>, botToken: string | undefined): HttpRequest {
  const channelId = requireConfig(config, "channelId", "channel ID");
  if (!/^\d{15,25}$/.test(channelId)) throw new ChannelNotConfiguredError("The channel ID must be a Discord channel's numeric ID");
  if (!botToken) throw new ChannelNotConfiguredError("DISCORD_BOT_TOKEN is not set");
  return {
    url: `https://discord.com/api/v10/channels/${channelId}/messages`,
    headers: { "Content-Type": "application/json", Authorization: `Bot ${botToken}` },
    body: JSON.stringify({ embeds: [buildDiscordEmbed(alert)], allowed_mentions: { parse: [] } }),
  };
}

export const sendDiscordBot: ChannelSender = async (alert, config, ctx) => {
  await post(buildDiscordBotRequest(alert, config, appConfig.discordBotToken), ctx, { service: "Discord", retryOn429: true });
};
