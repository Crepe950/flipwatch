import { describe, expect, it } from "vitest";
import {
  channelSummary,
  formDataToChannelInput,
  maskSecret,
  toChannelView,
  validateChannelInput,
  type ChannelFormInput,
} from "@/app/settings/channel-config";
import type { NotificationChannel } from "@/lib/db/schema";
import { CHANNEL_TYPES, getChannelType, type ChannelField } from "@/lib/notify/channel-types";
import { buildNtfyRequest } from "@/lib/notify/channels/ntfy";
import { buildPushoverRequest } from "@/lib/notify/channels/pushover";
import { makeAlert } from "@/lib/notify/test/fixtures";

const label = (type: string) => getChannelType(type)!.label;
const fieldLabel = (type: string, key: string) => getChannelType(type)!.fields.find((f) => f.key === key)!.label;

function form(type: string, fields: Record<string, string>, extra: Partial<ChannelFormInput> = {}): ChannelFormInput {
  return { name: "", type, fields, ...extra };
}

/** A value that passes validation for a field. */
function sample(field: ChannelField): string {
  if (field.type === "url") return "https://example.com/hook";
  if (field.type === "email") return "me@example.com";
  if (field.pattern?.source.includes("{30}")) return "a".repeat(30);
  if (field.pattern?.source.includes("\\d{15,25}")) return "123456789012345678";
  return "value-12345678";
}

function channel(overrides: Partial<NotificationChannel>): NotificationChannel {
  return {
    id: 1,
    name: "Channel",
    type: "ntfy",
    config: {},
    enabled: true,
    lastSuccessAt: null,
    lastError: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("validateChannelInput", () => {
  it.each(CHANNEL_TYPES.map((t) => [t.type, t] as const))("accepts a complete %s config and requires its required fields", (_type, info) => {
    const all = Object.fromEntries(info.fields.map((f) => [f.key, sample(f)]));
    const ok = validateChannelInput(form(info.type, all));
    expect(ok).toEqual({ ok: true, value: { name: info.label, type: info.type, config: all } });

    const missing = validateChannelInput(form(info.type, {}));
    const required = info.fields.filter((f) => f.required);
    if (required.length === 0) {
      expect(missing.ok).toBe(true);
    } else {
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(Object.keys(missing.errors).sort()).toEqual(required.map((f) => `config.${f.key}`).sort());
    }
  });

  it("validates URL and email fields", () => {
    const discord = validateChannelInput(form("discord", { webhookUrl: "javascript:alert(1)" }));
    expect(discord).toEqual({ ok: false, errors: { "config.webhookUrl": "Enter a full http(s):// URL" } });
    expect(validateChannelInput(form("discord", { webhookUrl: "discord.com/api/webhooks/1" })).ok).toBe(false);
    expect(validateChannelInput(form("email", { to: "not-an-email" }))).toEqual({
      ok: false,
      errors: { "config.to": "Enter a valid email address" },
    });
    expect(validateChannelInput(form("ntfy", { topic: "t", server: "ftp://ntfy.example" })).ok).toBe(false);
  });

  it("trims values, drops unknown and blank optional keys", () => {
    const result = validateChannelInput(form("ntfy", { topic: "  flipwatch-7f3k  ", server: " ", token: "", evil: "x" }, { name: "  My   phone " }));
    expect(result).toEqual({ ok: true, value: { name: "My phone", type: "ntfy", config: { topic: "flipwatch-7f3k" } } });
  });

  it("rejects unknown types and overlong names", () => {
    expect(validateChannelInput(form("carrier-pigeon", {}))).toEqual({ ok: false, errors: { type: "Choose a channel type" } });
    const long = validateChannelInput(form("ntfy", { topic: "t" }, { name: "n".repeat(61) }));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors.name).toMatch(/60/);
  });

  it("keeps saved secrets when left blank and replaces them when typed", () => {
    const existing = { type: "telegram" as const, config: { botToken: "123456:SECRET-TOKEN", chatId: "42" } };
    expect(validateChannelInput(form("telegram", { botToken: "", chatId: "43" }), existing)).toEqual({
      ok: true,
      value: { name: label("telegram"), type: "telegram", config: { botToken: "123456:SECRET-TOKEN", chatId: "43" } },
    });
    const replaced = validateChannelInput(form("telegram", { botToken: "999:NEW", chatId: "43" }), existing);
    expect(replaced.ok && replaced.value.config.botToken).toBe("999:NEW");
  });

  it("clears optional secrets on request but never required ones", () => {
    const ntfy = { type: "ntfy" as const, config: { topic: "t", token: "tk_123456789" } };
    const cleared = validateChannelInput(form("ntfy", { topic: "t", token: "" }, { clear: ["token"] }), ntfy);
    expect(cleared).toEqual({ ok: true, value: { name: label("ntfy"), type: "ntfy", config: { topic: "t" } } });

    const pushover = { type: "pushover" as const, config: { userKey: "u".repeat(30), appToken: "a".repeat(30) } };
    const kept = validateChannelInput(form("pushover", {}, { clear: ["userKey"] }), pushover);
    expect(kept.ok && kept.value.config).toEqual(pushover.config);
  });

  it("rejects values the channel's sender would always reject", () => {
    expect(validateChannelInput(form("ntfy", { topic: "my alerts" }))).toEqual({
      ok: false,
      errors: { "config.topic": "Use up to 64 letters, numbers, - and _ (no spaces)" },
    });
    expect(validateChannelInput(form("ntfy", { topic: "t".repeat(65) })).ok).toBe(false);
    const pushover = validateChannelInput(form("pushover", { userKey: "uQiRzpo4DXghDmr9QzzfQu27cmVRs", appToken: "short" }));
    expect(pushover).toEqual({
      ok: false,
      errors: {
        "config.userKey": "Pushover user keys are 30 letters and digits",
        "config.appToken": "Pushover application tokens are 30 letters and digits",
      },
    });
  });

  it("accepts exactly what the ntfy and Pushover senders accept", () => {
    const alert = makeAlert();
    for (const topic of ["flipwatch-7f3k", "A_b-1", "x".repeat(64), "x".repeat(65), "has space", "émoji", "a/b"]) {
      const sends = (() => {
        try {
          buildNtfyRequest(alert, { topic });
          return true;
        } catch {
          return false;
        }
      })();
      expect(validateChannelInput(form("ntfy", { topic })).ok, topic).toBe(sends);
    }
    for (const key of ["a".repeat(30), "a".repeat(29), "a".repeat(31), `${"a".repeat(29)}-`]) {
      const sends = (() => {
        try {
          buildPushoverRequest(alert, { userKey: key, appToken: key });
          return true;
        } catch {
          return false;
        }
      })();
      expect(validateChannelInput(form("pushover", { userKey: key, appToken: key })).ok, key).toBe(sends);
    }
  });

  it("treats webhook URLs as secrets: a blank field keeps the saved URL", () => {
    for (const [type, key] of [
      ["discord", "webhookUrl"],
      ["slack", "webhookUrl"],
      ["webhook", "url"],
    ] as const) {
      const existing = { type, config: { [key]: "https://hooks.example.com/services/T000/B000/SECRETTOKEN" } };
      const kept = validateChannelInput(form(type, { [key]: "" }), existing);
      expect(kept.ok && kept.value.config[key], type).toBe("https://hooks.example.com/services/T000/B000/SECRETTOKEN");
      const replaced = validateChannelInput(form(type, { [key]: "https://hooks.example.com/new" }), existing);
      expect(replaced.ok && replaced.value.config[key], type).toBe("https://hooks.example.com/new");
    }
  });

  it("keeps the existing type when editing even if the form claims another", () => {
    const result = validateChannelInput(form("webhook", { topic: "t" }), { type: "ntfy", config: { topic: "old" } });
    expect(result.ok && result.value.type).toBe("ntfy");
  });
});

describe("channel display", () => {
  it("masks secrets, showing the last 4 only for long values", () => {
    expect(maskSecret("123456:ABCDEFGH")).toBe("••••EFGH");
    expect(maskSecret("short")).toBe("••••");
  });

  it("summarizes without leaking secrets or webhook tokens", () => {
    expect(channelSummary("discord", { webhookUrl: "https://discord.com/api/webhooks/1/SECRET" })).toBe("discord.com/…");
    expect(channelSummary("ntfy", { topic: "flipwatch-7f3k", token: "tk_secret" })).toBe("flipwatch-7f3k");
    expect(channelSummary("pushover", { userKey: "uQiRzpo4DXghDmr9QzzfQu27cmVRsG", appToken: "x" })).toBe(
      `${fieldLabel("pushover", "userKey")} ••••VRsG`,
    );
    expect(channelSummary("webpush", {})).toBe("Subscribed browsers and devices");
    expect(channelSummary("unknown", { a: "b" })).toBe("");
  });

  it("builds a browser-safe view", () => {
    const view = toChannelView(
      channel({
        type: "telegram",
        name: "Bot",
        config: { botToken: "123456:SUPERSECRET", chatId: "42" },
        lastSuccessAt: new Date("2026-09-01T10:00:00Z"),
      }),
    );
    expect(view).toMatchObject({
      typeLabel: label("telegram"),
      values: { chatId: "42" },
      secrets: { botToken: "••••CRET" },
      lastSuccessAt: "2026-09-01T10:00:00.000Z",
    });
    expect(JSON.stringify(view)).not.toContain("SUPERSECRET");
  });

  it("never sends webhook URLs to the browser, only a mask and the host", () => {
    const url = "https://discord.com/api/webhooks/123/SUPERSECRETTOKEN";
    const view = toChannelView(channel({ type: "discord", config: { webhookUrl: url } }));
    expect(view).toMatchObject({ values: {}, secrets: { webhookUrl: "••••OKEN" }, summary: "discord.com/…" });
    expect(JSON.stringify(view)).not.toContain("SUPERSECRET");
    const hook = toChannelView(channel({ type: "webhook", config: { url: "https://example.com/hooks/abc?token=SUPERSECRET", secret: "s3cr3t-value" } }));
    expect(JSON.stringify(hook)).not.toContain("SUPERSECRET");
    expect(hook.summary).toBe("example.com/…");
  });

  it("reads channel forms", () => {
    const fd = new FormData();
    fd.set("name", "Phone");
    fd.set("type", "ntfy");
    fd.set("channelId", "3");
    fd.set("field.topic", "abc");
    fd.set("field.token", "");
    fd.append("clear", "token");
    expect(formDataToChannelInput(fd)).toEqual({ name: "Phone", type: "ntfy", fields: { topic: "abc", token: "" }, clear: ["token"] });
    expect(formDataToChannelInput(new FormData())).toEqual({ name: "", type: "", fields: {}, clear: [] });
  });
});
