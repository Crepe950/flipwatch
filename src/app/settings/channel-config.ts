/**
 * Validation and safe display of notification channel settings, driven by CHANNEL_TYPES.
 * Pure (no Next/DB imports) so it is unit-testable and usable from server actions.
 */
import { z } from "zod";
import type { NotificationChannel } from "@/lib/db/schema";
import { getChannelType, type ChannelField } from "@/lib/notify/channel-types";
import type { NotificationChannelType } from "@/lib/types";

const NAME_MAX = 60;
const VALUE_MAX = 2_000;
const email = z.email();

export interface ChannelFormInput {
  name: string;
  type: string;
  /** Raw field values keyed by ChannelField.key. */
  fields: Record<string, string>;
  /** Optional secret fields whose saved value should be removed. */
  clear?: string[];
}

export interface ValidChannel {
  name: string;
  type: NotificationChannelType;
  config: Record<string, string>;
}

export type ChannelValidation = { ok: true; value: ValidChannel } | { ok: false; errors: Record<string, string> };

/** Credentials (passwords, tokens, webhook URLs): never sent back to the browser, only masked. */
export function isSecretField(field: ChannelField): boolean {
  return field.type === "password" || field.secret === true;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function fieldError(field: ChannelField, value: string): string | null {
  if (value.length > VALUE_MAX) return `${field.label} is too long`;
  if (field.type === "url" && !isHttpUrl(value)) return "Enter a full http(s):// URL";
  if (field.type === "email" && !email.safeParse(value).success) return "Enter a valid email address";
  if (field.pattern && !field.pattern.test(value)) return field.patternMessage ?? `${field.label} isn't in the expected format`;
  return null;
}

/**
 * Validate a channel form against its CHANNEL_TYPES definition. When editing, the type is fixed
 * to the existing one and a blank secret keeps the saved value (secrets are never sent back to
 * the browser, so the form can't prefill them). Unknown keys are dropped.
 */
export function validateChannelInput(input: ChannelFormInput, existing?: Pick<NotificationChannel, "type" | "config"> | null): ChannelValidation {
  const errors: Record<string, string> = {};
  const type = existing ? existing.type : input.type;
  const info = getChannelType(type);
  if (!info) return { ok: false, errors: { type: "Choose a channel type" } };

  const name = input.name.trim().replace(/\s+/g, " ") || info.label;
  if (name.length > NAME_MAX) errors.name = `Keep the name under ${NAME_MAX} characters`;

  const clear = new Set(input.clear ?? []);
  const config: Record<string, string> = {};
  for (const field of info.fields) {
    const value = (input.fields[field.key] ?? "").trim();
    const saved = existing?.config?.[field.key];
    if (!value) {
      if (isSecretField(field) && saved && !(clear.has(field.key) && !field.required)) {
        config[field.key] = saved;
      } else if (field.required) {
        errors[`config.${field.key}`] = `${field.label} is required`;
      }
      continue;
    }
    const error = fieldError(field, value);
    if (error) errors[`config.${field.key}`] = error;
    else config[field.key] = value;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, type: info.type, config } };
}

/** Read a channel form: name, type, `field.<key>` values and `clear` checkboxes. */
export function formDataToChannelInput(formData: FormData): ChannelFormInput {
  const fields: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("field.") && typeof value === "string") fields[key.slice("field.".length)] = value;
  }
  return {
    name: String(formData.get("name") ?? ""),
    type: String(formData.get("type") ?? ""),
    fields,
    clear: formData.getAll("clear").filter((v): v is string => typeof v === "string"),
  };
}

/** "••••1a2b" for secrets long enough that the last 4 characters don't give much away. */
export function maskSecret(value: string): string {
  return value.length >= 8 ? `••••${value.slice(-4)}` : "••••";
}

function describeUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname.length > 1 ? `${url.host}/…` : url.host;
  } catch {
    return "(invalid URL)";
  }
}

/** Short, secret-free description of where a channel delivers, e.g. "discord.com/…" or "#flipwatch-7f3k". */
export function channelSummary(type: string, config: Record<string, string>): string {
  if (type === "webpush") return "Subscribed browsers and devices";
  const info = getChannelType(type);
  for (const field of info?.fields ?? []) {
    const value = config[field.key];
    if (!value) continue;
    // Host only: webhook URLs carry their token in the path.
    if (field.type === "url") return describeUrl(value);
    if (isSecretField(field)) return `${field.label} ${maskSecret(value)}`;
    return value.length > 48 ? `${value.slice(0, 47)}…` : value;
  }
  return "";
}

/** What the browser may see of a channel: plain values for normal fields, masks for secrets. */
export interface ChannelView {
  id: number;
  name: string;
  type: NotificationChannelType;
  typeLabel: string;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  summary: string;
  values: Record<string, string>;
  secrets: Record<string, string>;
}

export function toChannelView(channel: NotificationChannel): ChannelView {
  const info = getChannelType(channel.type);
  const values: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of info?.fields ?? []) {
    const value = channel.config?.[field.key];
    if (!value) continue;
    if (isSecretField(field)) secrets[field.key] = maskSecret(value);
    else values[field.key] = value;
  }
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    typeLabel: info?.label ?? channel.type,
    enabled: channel.enabled,
    lastSuccessAt: channel.lastSuccessAt ? channel.lastSuccessAt.toISOString() : null,
    lastError: channel.lastError,
    summary: channelSummary(channel.type, channel.config ?? {}),
    values,
    secrets,
  };
}
