import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setAiClientFactory } from "./ai/client";
import { createFakeClient, jsonMessage, userText } from "./ai/testing/fake-client";
import { createTestDb, type Db } from "./db";
import { searches } from "./db/schema";
import { DEFAULT_LOCATION, findPreset } from "./locations";
import { createSearch } from "./queries/searches";
import { setDefaultLocation } from "./queries/settings";
import { applySearchPlan, runSearchRequest, type SearchPlan } from "./search-assistant";
import { searchInputSchema } from "./search-schema";

let db: Db;
let close: () => Promise<void>;
const savedKey = process.env.ANTHROPIC_API_KEY;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
});
afterEach(async () => {
  setAiClientFactory(null);
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  await close();
});

const noChanges: SearchPlan["changes"] = {
  name: null, query: null, excludeTerms: null, titleMustMatch: null, minPrice: null, maxPrice: null, expectedResale: null,
  marketplaces: null, location: null, radiusKm: null, category: null, pollIntervalMinutes: null, notifyMinDealScore: null,
  notifyMinAiScore: null, aiInstructions: null, aiEvaluate: null, clear: [],
};

async function seedPs5() {
  return createSearch(
    db,
    searchInputSchema.parse({ name: "PS5", query: "ps5", minPriceCents: 30_000, maxPriceCents: 80_000, marketplaces: ["craigslist"], location: DEFAULT_LOCATION }),
  );
}

describe("search assistant", () => {
  it("creates a search from Claude's plan, showing Claude the current searches", async () => {
    await seedPs5();
    const client = createFakeClient(() =>
      jsonMessage({
        action: "create",
        searchId: null,
        changes: { ...noChanges, name: "RTX 3080", query: 'rtx 3080 | "rtx 3080 ti"', excludeTerms: ["laptop", "wanted"], maxPrice: 450, notifyMinAiScore: 70 },
        reply: "Watching for RTX 3080s under $450.",
      }),
    );
    setAiClientFactory(() => client);

    const result = await runSearchRequest(db, "watch for rtx 3080s under $450");

    expect(userText(client.calls[0])).toContain('"name": "PS5"');
    expect(result.action).toBe("create");
    expect(result.search).toMatchObject({
      name: "RTX 3080",
      query: 'rtx 3080 | "rtx 3080 ti"',
      maxPriceCents: 45_000,
      titleMustMatch: true,
      notifyMinAiScore: 70,
      notifyMinProfitPct: null,
      aiEvaluate: true,
      enabled: true,
      pollIntervalSec: 900,
    });
    expect(result.reply).toMatch(/^Watching for RTX 3080s under \$450\.\n\nCreated:\n\*\*RTX 3080\*\*/);
  });

  it("starts new searches at the default location from Settings", async () => {
    await setDefaultLocation(db, { ...findPreset("Victoria, BC")!, radiusKm: 25 });
    const result = await applySearchPlan(db, { action: "create", searchId: null, changes: { ...noChanges, name: "Bikes", query: "road bike" }, reply: "" });
    expect(result.search?.location).toMatchObject({ label: "Victoria, BC", radiusKm: 25, craigslistSite: "victoria" });
  });

  it("updates only what changed, clears fields on request and keeps a muted search muted", async () => {
    const ps5 = await seedPs5();
    await db.update(searches).set({ notifyChannelIds: [] }).where(eq(searches.id, ps5.id));

    const result = await applySearchPlan(db, {
      action: "update",
      searchId: ps5.id,
      changes: { ...noChanges, maxPrice: 700, clear: ["minPrice"] },
      reply: "",
    });

    expect(result.search).toMatchObject({ id: ps5.id, name: "PS5", query: "ps5", minPriceCents: null, maxPriceCents: 70_000, notifyChannelIds: [] });
  });

  it("pauses, mutes and lists", async () => {
    const ps5 = await seedPs5();
    await applySearchPlan(db, { action: "pause", searchId: ps5.id, changes: {}, reply: "" });
    const muted = await applySearchPlan(db, { action: "mute", searchId: ps5.id, changes: {}, reply: "" });
    expect(muted.search).toMatchObject({ enabled: false, notifyChannelIds: [] });

    const list = await applySearchPlan(db, { action: "list", searchId: null, changes: {}, reply: "" });
    expect(list.reply).toContain("**PS5** (#");
    expect(list.reply).toContain("paused");
    expect(list.reply).toContain("alerts muted");
  });

  it("refuses invalid or unknown targets with a readable error", async () => {
    await expect(applySearchPlan(db, { action: "update", searchId: 999, changes: {}, reply: "" })).rejects.toThrow(/which search/);
    await expect(
      applySearchPlan(db, { action: "create", searchId: null, changes: { ...noChanges, name: "X", query: "x", location: "Atlantis" }, reply: "" }),
    ).rejects.toThrow(/Unknown location/);
    await expect(applySearchPlan(db, { action: "create", searchId: null, changes: { ...noChanges, name: "No query" }, reply: "" })).rejects.toThrow(
      /isn't valid/,
    );
  });
});
