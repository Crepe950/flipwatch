import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "./config";
import { createTestDb, type Db } from "./db";
import { discordBotStatus, discordInviteUrl, startDiscordBot } from "./discord-bot";
import { ebayStatus } from "./marketplaces/ebay/credentials";
import { publicRuntimeSettings, saveRuntimeSettings, setRuntimeSettingsForTests } from "./runtime-settings";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => {
  setRuntimeSettingsForTests(null);
  await close();
});
afterEach(() => vi.unstubAllEnvs());

describe("eBay and Discord settings saved in the app", () => {
  it("win over the environment, and keep secrets out of what pages see", async () => {
    vi.stubEnv("EBAY_CLIENT_ID", "env-id");
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    setRuntimeSettingsForTests({});
    expect(config.ebayClientId).toBe("env-id");

    await saveRuntimeSettings(db, {
      ebayClientId: "Me-FlipWatc-PRD-1234",
      ebayClientSecret: "PRD-abcdef1234567890",
      // Built from parts so it can never be mistaken for a real token by secret scanners.
      discordBotToken: ["FAKE-TOKEN-FOR-TESTS-ONLY", "abcdef", "not-a-real-discord-token-0123"].join("."),
      discordAllowedUserIds: "123456789012345678, 987654321098765432",
    });
    expect(config.ebayClientId).toBe("Me-FlipWatc-PRD-1234");
    expect(config.ebayClientSecret).toBe("PRD-abcdef1234567890");
    expect(config.discordAllowedUserIds).toEqual(["123456789012345678", "987654321098765432"]);
    expect(ebayStatus().ok).toBe(true);

    const shown = JSON.stringify(publicRuntimeSettings());
    expect(shown).toContain("Me-FlipWatc-PRD-1234"); // the App ID is not secret
    expect(shown).not.toContain("abcdef1234567890");
    expect(shown).not.toContain("abcdefghijklmnopqrstuvwxyz0123");

    await saveRuntimeSettings(db, { ebayClientId: "", ebayClientSecret: "", discordBotToken: "" });
    expect(config.ebayClientId).toBe("env-id");
    expect(config.discordBotToken).toBe("env-token");
  });

  it("reports the bot as off without a token, and builds the invite link", () => {
    setRuntimeSettingsForTests({});
    expect(startDiscordBot(async () => db)).toBeNull();
    expect(discordBotStatus()).toEqual({ state: "off" });
    const url = new URL(discordInviteUrl("111111111111111111"));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("111111111111111111");
    expect(url.searchParams.get("scope")).toBe("bot applications.commands");
    expect(url.searchParams.get("permissions")).toBe("3072");
  });
});
