/**
 * Notifications public API: turns engine match events into alerts on ntfy, Discord, Slack,
 * Telegram, Pushover, email, browser push and custom webhooks.
 */
export { CHANNEL_TYPES, getChannelType } from "./channel-types";
export type { ChannelTypeInfo, ChannelField } from "./channel-types";

/** Deliver alerts for engine events (skips silent ones, respects per-search channel selection). */
export { notifyMatchEvents, MAX_INDIVIDUAL_ALERTS } from "./dispatcher";
export type { NotifyOptions } from "./dispatcher";
/** Send a sample alert through one channel; updates the channel's lastSuccessAt/lastError. */
export { sendTestNotification } from "./test-notification";
export type { TestNotificationOptions } from "./test-notification";
export { SEND_TIMEOUT_MS } from "./delivery";
export {
  browserPushSubscriptionSchema,
  deletePushSubscription,
  getVapidPublicKey,
  savePushSubscription,
} from "./push-subscriptions";
export type { BrowserPushSubscription } from "./push-subscriptions";
export type { Alert, AlertKind } from "./types";
