import type { NotificationChannelType } from "../../types";
import type { ChannelSender } from "../types";
import { sendDiscord, sendDiscordBot } from "./discord";
import { sendEmail } from "./email";
import { sendNtfy } from "./ntfy";
import { sendPushover } from "./pushover";
import { sendSlack } from "./slack";
import { sendTelegram } from "./telegram";
import { sendWebhook } from "./webhook";
import { sendWebPush } from "./webpush";

export const CHANNEL_SENDERS: Record<NotificationChannelType, ChannelSender> = {
  ntfy: sendNtfy,
  discord: sendDiscord,
  discord_bot: sendDiscordBot,
  slack: sendSlack,
  telegram: sendTelegram,
  pushover: sendPushover,
  email: sendEmail,
  webpush: sendWebPush,
  webhook: sendWebhook,
};
