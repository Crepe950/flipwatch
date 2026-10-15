import type { NotificationChannelType } from "../types";

export interface ChannelField {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "email";
  required: boolean;
  placeholder?: string;
  help?: string;
  /**
   * A credential that is never sent back to the browser (masked in Settings; blank keeps the saved
   * value). Password fields always are; set this for e.g. webhook URLs that embed a token.
   */
  secret?: boolean;
  /** What the channel's sender accepts; the Settings form rejects anything else up front. */
  pattern?: RegExp;
  /** Error shown when the value doesn't match `pattern`. */
  patternMessage?: string;
}

export interface ChannelTypeInfo {
  type: NotificationChannelType;
  label: string;
  description: string;
  /** Link to setup docs shown in the UI. */
  docsUrl?: string;
  fields: ChannelField[];
}

/** Metadata that drives the generic "Add channel" form in Settings. */
export const CHANNEL_TYPES: ChannelTypeInfo[] = [
  {
    type: "ntfy",
    label: "ntfy (phone push)",
    description: "Free instant push notifications to the ntfy app on iOS/Android. Pick a hard-to-guess topic name.",
    docsUrl: "https://docs.ntfy.sh/",
    fields: [
      {
        key: "topic",
        label: "Topic",
        type: "text",
        required: true,
        placeholder: "flipwatch-7f3k2q",
        help: "Letters, numbers, - and _ only. Anyone who knows the topic can read it.",
        // Same rule as the ntfy sender (channels/ntfy.ts).
        pattern: /^[-_A-Za-z0-9]{1,64}$/,
        patternMessage: "Use up to 64 letters, numbers, - and _ (no spaces)",
      },
      { key: "server", label: "Server URL", type: "url", required: false, placeholder: "https://ntfy.sh", help: "Leave blank for ntfy.sh" },
      { key: "token", label: "Access token", type: "password", required: false, help: "Only for protected topics" },
    ],
  },
  {
    type: "discord",
    label: "Discord",
    description: "Post alerts to a Discord channel via an incoming webhook.",
    docsUrl: "https://support.discord.com/hc/en-us/articles/228383668",
    fields: [{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true, secret: true, placeholder: "https://discord.com/api/webhooks/…" }],
  },
  {
    type: "discord_bot",
    label: "Discord (FlipWatch bot)",
    description: "Post alerts to a channel through the FlipWatch Discord bot (set up the bot in Settings → Discord bot and add it to that server).",
    fields: [
      {
        key: "channelId",
        label: "Channel ID",
        type: "text",
        required: true,
        placeholder: "123456789012345678",
        help: "With Developer Mode on in Discord, right-click the channel → Copy Channel ID.",
        pattern: /^\d{15,25}$/,
        patternMessage: "A Discord channel ID is a long number",
      },
    ],
  },
  {
    type: "slack",
    label: "Slack",
    description: "Post alerts to a Slack channel via an incoming webhook.",
    docsUrl: "https://api.slack.com/messaging/webhooks",
    fields: [{ key: "webhookUrl", label: "Webhook URL", type: "url", required: true, secret: true, placeholder: "https://hooks.slack.com/services/…" }],
  },
  {
    type: "telegram",
    label: "Telegram",
    description: "Message yourself through a Telegram bot (create one with @BotFather).",
    docsUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
    fields: [
      { key: "botToken", label: "Bot token", type: "password", required: true, placeholder: "123456:ABC-DEF…" },
      {
        key: "chatId",
        label: "Chat ID",
        type: "text",
        required: true,
        placeholder: "123456789",
        help: "Message your bot, then open api.telegram.org/bot<token>/getUpdates and copy chat.id (groups start with -100).",
      },
    ],
  },
  {
    type: "pushover",
    label: "Pushover",
    description: "Reliable push notifications via Pushover (paid app, high priority support).",
    docsUrl: "https://pushover.net/api",
    fields: [
      // Same rule as the Pushover sender (channels/pushover.ts).
      {
        key: "userKey",
        label: "User key",
        type: "password",
        required: true,
        help: "Shown on your Pushover dashboard",
        pattern: /^[A-Za-z0-9]{30}$/,
        patternMessage: "Pushover user keys are 30 letters and digits",
      },
      {
        key: "appToken",
        label: "Application token",
        type: "password",
        required: true,
        help: "Create an application at pushover.net/apps/build",
        pattern: /^[A-Za-z0-9]{30}$/,
        patternMessage: "Pushover application tokens are 30 letters and digits",
      },
    ],
  },
  {
    type: "email",
    label: "Email",
    description: "Email alerts through the SMTP server configured in SMTP_URL.",
    fields: [{ key: "to", label: "Send to", type: "email", required: true, placeholder: "you@example.com" }],
  },
  {
    type: "webpush",
    label: "Browser push",
    description: "Native push notifications in this browser (installable as an app on your phone's home screen). Requires VAPID keys.",
    fields: [],
  },
  {
    type: "webhook",
    label: "Custom webhook",
    description: "POST a JSON payload for every alert to any URL (Zapier, n8n, Make, your own code).",
    fields: [
      { key: "url", label: "URL", type: "url", required: true, secret: true, placeholder: "https://example.com/hooks/flipwatch" },
      { key: "secret", label: "Signing secret", type: "password", required: false, help: "Sent as an HMAC-SHA256 X-FlipWatch-Signature header" },
    ],
  },
];

export function getChannelType(type: string): ChannelTypeInfo | undefined {
  return CHANNEL_TYPES.find((c) => c.type === type);
}
