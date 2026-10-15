import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "../../db";
import { notificationChannels, notificationLog } from "../../db/schema";
import { sendTestNotification } from "../test-notification";
import { APP_URL, NOW, seedChannel, stubFetch } from "./fixtures";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

const channelRow = async (id: number) => (await db.select().from(notificationChannels).where(eq(notificationChannels.id, id)))[0];

describe("sendTestNotification", () => {
  it("sends a sample alert through only that channel and records success", async () => {
    const target = await seedChannel(db, "discord", { webhookUrl: "https://discord.com/api/webhooks/1/abc" }, { lastError: "old failure" });
    await seedChannel(db, "webhook", { url: "https://hooks.example.com/other" });
    const { calls } = stubFetch();

    const result = await sendTestNotification(db, target.id, { now: NOW, appUrl: APP_URL });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://discord.com/api/webhooks/1/abc");
    const embed = (calls[0].json.embeds as Array<{ title: string; footer: { text: string } }>)[0];
    expect(embed.title).toContain("Sony PS5 Digital Edition");
    expect(embed.footer.text).toBe("FlipWatch · test alert");

    const row = await channelRow(target.id);
    expect(row.lastSuccessAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(await db.select().from(notificationLog)).toMatchObject([{ channelId: target.id, matchId: null, status: "sent" }]);
  });

  it("works for disabled channels and reports failures", async () => {
    const target = await seedChannel(db, "webhook", { url: "https://hooks.example.com/x" }, { enabled: false });
    stubFetch(() => new Response("forbidden", { status: 403 }));

    const result = await sendTestNotification(db, target.id);

    expect(result).toEqual({ ok: false, error: "Webhook returned HTTP 403: forbidden" });
    const row = await channelRow(target.id);
    expect(row.lastError).toBe("Webhook returned HTTP 403: forbidden");
    expect(row.lastSuccessAt).toBeNull();
    expect(await db.select().from(notificationLog)).toMatchObject([{ status: "failed", error: "Webhook returned HTTP 403: forbidden" }]);
  });

  it("reports configuration problems without calling out", async () => {
    const target = await seedChannel(db, "telegram", { botToken: "", chatId: "1" });
    const { calls } = stubFetch();
    expect(await sendTestNotification(db, target.id)).toEqual({ ok: false, error: "Missing bot token" });
    expect(calls).toHaveLength(0);
    expect((await channelRow(target.id)).lastError).toBe("Missing bot token");
  });

  it("handles unknown channels", async () => {
    expect(await sendTestNotification(db, 12345)).toEqual({ ok: false, error: "Channel not found" });
  });
});
