import { config } from "../config";
import { APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "../db";
import { aiEvaluations, listings, searches } from "../db/schema";
import type { Listing, Search } from "../db/schema";
import { createAnthropicClient, DEFAULT_AI_MODEL } from "./client";
import { AiNotConfiguredError, AiRequestError } from "./errors";
import { aiStatus, evaluateListing, evaluateMatchEvents, setAiClientFactory } from "./index";
import { EVALUATION_SYSTEM_PROMPT } from "./prompts";
import { EVALUATION_JSON_SCHEMA } from "./schema";
import { apiError, createFakeClient, jsonMessage, textMessage, userContent, userText, type FakeClient, type FakeResponder } from "./testing/fake-client";
import { seedListing, seedMatch, seedPrice, seedSearch } from "./testing/seed";

const API_KEY = "sk-ant-test-key-123";
const DAY = 24 * 60 * 60 * 1000;

const ANSWER = {
  verdict: "good",
  dealScore: 71.6,
  estimatedResaleLow: 520,
  estimatedResaleHigh: 450,
  suggestedOffer: 300.5,
  summary: "Priced well under local comps with both controllers. Solid margin after fees. A third sentence.",
  reasons: ["22% below the median of 5 comparable listings", "Includes two controllers"],
  redFlags: [],
  questionsForSeller: ["Has the console ever been opened or repaired?", "Does the disc drive read games without noise?"],
};

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AI_MODEL"] as const;

let db: Db;
let close: () => Promise<void>;
let savedEnv: Record<string, string | undefined>;
let fake: FakeClient;

function useFake(respond: FakeResponder): FakeClient {
  fake = createFakeClient(respond);
  setAiClientFactory(() => fake);
  return fake;
}

interface Fixture {
  search: Search;
  listing: Listing;
}

/** A PS5 listing matched by a search that also matched five comparable CAD listings (plus noise). */
async function seedFixture(): Promise<Fixture> {
  const search = await seedSearch(db, { name: "PS5 deals", aiEvaluate: true, expectedResaleCents: 50000 });
  const listing = await seedListing(db, {
    title: "PS5 Disc Edition + 2 controllers",
    description: "Works perfectly, moving sale.",
    priceCents: 35000,
    originalPriceCents: 42000,
    imageUrls: ["https://images.example/ps5-1.jpg", "https://images.example/ps5-2.jpg", "https://images.example/ps5-3.jpg"],
    condition: "used",
  });
  await seedMatch(db, search.id, listing.id);
  await seedPrice(db, listing.id, 42000, new Date(Date.now() - 3 * DAY));
  await seedPrice(db, listing.id, 35000, new Date(Date.now() - DAY));

  for (const priceCents of [40000, 42000, 45000, 50000, 60000]) {
    const comp = await seedListing(db, { priceCents });
    await seedMatch(db, search.id, comp.id);
  }
  const old = new Date(Date.now() - 60 * DAY);
  const noise = [
    await seedListing(db, { priceCents: 5000, lastSeenAt: old }), // outside the 30-day window
    await seedListing(db, { priceCents: 90000, currency: "USD" }), // different currency
    await seedListing(db, { priceCents: null }), // no price
    await seedListing(db, { priceCents: 0 }), // free
  ];
  for (const comp of noise) await seedMatch(db, search.id, comp.id, { firstMatchedAt: comp.lastSeenAt });
  const otherSearch = await seedSearch(db, { name: "Other" });
  const unrelated = await seedListing(db, { priceCents: 1000 });
  await seedMatch(db, otherSearch.id, unrelated.id);

  return { search, listing };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ANTHROPIC_API_KEY = API_KEY;
  // Deleting listings cascades to price history, matches and evaluations.
  await db.delete(listings);
  await db.delete(searches);
});

afterEach(() => {
  setAiClientFactory(null);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("aiStatus", () => {
  it("points to Settings → AI when not configured", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const status = aiStatus();
    expect(status.configured).toBe(false);
    expect(status.model).toBe(DEFAULT_AI_MODEL);
    expect(status.message).toContain("Settings → AI");
  });

  it("reports the configured model", () => {
    process.env.AI_MODEL = "claude-sonnet-5-5";
    expect(aiStatus()).toMatchObject({ configured: true, model: "claude-sonnet-5-5" });
  });
});

describe("evaluateListing", () => {
  it("throws a clear error when AI is not configured, without calling Claude", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { listing } = await seedFixture();
    useFake(() => jsonMessage(ANSWER));
    await expect(evaluateListing(db, listing.id)).rejects.toBeInstanceOf(AiNotConfiguredError);
    await expect(evaluateListing(db, listing.id)).rejects.toThrow(/Settings → AI/);
    expect(fake.calls).toHaveLength(0);
  });

  it("sends a structured-output request with images and comps, then stores the normalised evaluation", async () => {
    const { search, listing } = await seedFixture();
    useFake(() => jsonMessage(ANSWER, { cacheReadTokens: 300 }));

    const row = await evaluateListing(db, listing.id, { searchId: search.id });

    expect(fake.calls).toHaveLength(1);
    const { body } = fake.calls[0];
    expect(body.model).toBe(DEFAULT_AI_MODEL);
    expect(body.system).toBe(EVALUATION_SYSTEM_PROMPT);
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema: EVALUATION_JSON_SCHEMA } });
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
    // Must work on every current model: no forced tool choice, sampling params or thinking budgets.
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");

    const content = userContent(fake.calls[0]);
    expect(content.filter((b) => b.type === "image")).toEqual([
      { type: "image", source: { type: "url", url: "https://images.example/ps5-1.jpg" } },
      { type: "image", source: { type: "url", url: "https://images.example/ps5-2.jpg" } },
    ]);
    const text = userText(fake.calls[0]);
    expect(text).toContain('"count": 5');
    expect(text).toContain('"median": 450');
    expect(text).toContain('"min": 400');
    expect(text).toContain('"max": 600');
    expect(text).toContain('"askingVsMedianPercent": -22');
    expect(text).toContain('"price": 420');

    expect(row).toMatchObject({
      listingId: listing.id,
      searchId: search.id,
      model: "claude-haiku-4-5-20251001",
      verdict: "good",
      dealScore: 72,
      estimatedResaleLowCents: 45000,
      estimatedResaleHighCents: 52000,
      suggestedOfferCents: 30050,
      summary: "Priced well under local comps with both controllers. Solid margin after fees.",
      reasons: ANSWER.reasons,
      redFlags: [],
      questionsForSeller: ANSWER.questionsForSeller,
      inputTokens: 1500,
      outputTokens: 250,
    });
    const stored = await db.select().from(aiEvaluations);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(row);
  });

  it("uses AI_MODEL when set", async () => {
    process.env.AI_MODEL = "claude-sonnet-5-5";
    const { listing } = await seedFixture();
    useFake(() => jsonMessage(ANSWER, { model: "claude-sonnet-5-5" }));
    const row = await evaluateListing(db, listing.id);
    expect(fake.calls[0].body.model).toBe("claude-sonnet-5-5");
    expect(row.model).toBe("claude-sonnet-5-5");
  });

  it("defaults to the most recent search the listing matched (also when the given search is gone)", async () => {
    const { search, listing } = await seedFixture();
    const older = await seedSearch(db, { name: "Older" });
    await seedMatch(db, older.id, listing.id, { lastEventAt: new Date(Date.now() - 5 * DAY) });
    useFake(() => jsonMessage(ANSWER));

    expect((await evaluateListing(db, listing.id)).searchId).toBe(search.id);
    expect((await evaluateListing(db, listing.id, { searchId: 999_999 })).searchId).toBe(search.id);
    expect(userText(fake.calls[0])).toContain('"name": "PS5 deals"');
  });

  it("works for a listing that matched no search", async () => {
    const listing = await seedListing(db, { imageUrls: [] });
    useFake(() => jsonMessage(ANSWER));
    const row = await evaluateListing(db, listing.id);
    expect(row.searchId).toBeNull();
    expect(userText(fake.calls[0])).toContain('"comparableAskingPrices": null');
  });

  it("retries once without images when the API rejects an image", async () => {
    const { listing } = await seedFixture();
    useFake((_body, call) => {
      if (call === 0) throw apiError(400, "invalid_request_error", "Unable to download the file. Please verify the URL and try again.");
      return jsonMessage(ANSWER);
    });

    const row = await evaluateListing(db, listing.id);

    expect(row.verdict).toBe("good");
    expect(fake.calls).toHaveLength(2);
    expect(userContent(fake.calls[0]).some((b) => b.type === "image")).toBe(true);
    expect(userContent(fake.calls[1]).some((b) => b.type === "image")).toBe(false);
    expect(userText(fake.calls[1])).toContain("could not be attached");
  });

  it("does not retry a 400 when no images were sent, and stores nothing", async () => {
    const listing = await seedListing(db, { imageUrls: [] });
    useFake(() => {
      throw apiError(400, "invalid_request_error", "messages: bad request");
    });
    const error = await evaluateListing(db, listing.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiRequestError);
    expect((error as AiRequestError).message).toBe("Claude API error 400 invalid_request_error: messages: bad request");
    expect((error as AiRequestError).status).toBe(400);
    expect(fake.calls).toHaveLength(1);
    expect(await db.select().from(aiEvaluations)).toHaveLength(0);
  });

  it("reports the second failure when the text-only retry also fails", async () => {
    const { listing } = await seedFixture();
    useFake((_body, call) => {
      throw call === 0 ? apiError(400, "invalid_request_error", "bad image") : apiError(529, "overloaded_error", "Overloaded");
    });
    await expect(evaluateListing(db, listing.id)).rejects.toThrow("Claude API error 529 overloaded_error: Overloaded");
    expect(fake.calls).toHaveLength(2);
  });

  it("rethrows API errors concisely and without secrets", async () => {
    const listing = await seedListing(db);
    useFake(() => {
      throw apiError(429, "rate_limit_error", `Rate limited for key ${API_KEY}`);
    });
    const error = (await evaluateListing(db, listing.id).catch((e: unknown) => e)) as AiRequestError;
    expect(error).toBeInstanceOf(AiRequestError);
    expect(error.message).toMatch(/^Claude API error 429 rate_limit_error: /);
    expect(error.message).not.toContain(API_KEY);
    expect(error.type).toBe("rate_limit_error");
  });

  it("maps timeouts to a short message", async () => {
    const listing = await seedListing(db);
    useFake(() => {
      throw new APIConnectionTimeoutError();
    });
    await expect(evaluateListing(db, listing.id)).rejects.toThrow("Claude API request timed out");
  });

  it("rejects refusals, truncated answers and malformed JSON", async () => {
    const listing = await seedListing(db, { imageUrls: [] });
    useFake(() => textMessage("", { stopReason: "refusal" }));
    await expect(evaluateListing(db, listing.id)).rejects.toThrow(/declined/);

    useFake(() => textMessage('{"verdict": "go', { stopReason: "max_tokens" }));
    await expect(evaluateListing(db, listing.id)).rejects.toThrow(/cut off/);

    useFake(() => textMessage("I think this is a good deal!"));
    await expect(evaluateListing(db, listing.id)).rejects.toThrow(/not valid JSON/);

    useFake(() => jsonMessage({ ...ANSWER, verdict: "excellent" }));
    await expect(evaluateListing(db, listing.id)).rejects.toThrow(/invalid fields: verdict/);
    expect(await db.select().from(aiEvaluations)).toHaveLength(0);
  });

  it("throws for an unknown listing", async () => {
    useFake(() => jsonMessage(ANSWER));
    await expect(evaluateListing(db, 424242)).rejects.toThrow("Listing 424242 not found");
    await expect(evaluateListing(db, Number.NaN)).rejects.toThrow("Listing NaN not found");
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps at most AI_CONCURRENCY evaluations in flight", async () => {
    const ids: number[] = [];
    for (let i = 0; i < config.aiConcurrency + 4; i++) ids.push((await seedListing(db, { imageUrls: [] })).id);
    let running = 0;
    let peak = 0;
    useFake(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 25));
      running--;
      return jsonMessage(ANSWER);
    });

    const rows = await Promise.all(ids.map((id) => evaluateListing(db, id)));

    expect(rows.map((r) => r.listingId)).toEqual(ids);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBe(config.aiConcurrency);
  });

  it("shares one Claude call between concurrent requests for the same listing", async () => {
    const listing = await seedListing(db);
    useFake(() => jsonMessage(ANSWER));
    const [a, b] = await Promise.all([evaluateListing(db, listing.id), evaluateListing(db, listing.id)]);
    expect(a.id).toBe(b.id);
    expect(fake.calls).toHaveLength(1);

    await evaluateListing(db, listing.id);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("evaluateListing through the real SDK (injected fetch, no network)", () => {
  type FetchArgs = { url: string; init: RequestInit | undefined };

  function installFetch(responses: Array<{ status: number; body: unknown }>): FetchArgs[] {
    const seen: FetchArgs[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input instanceof Request ? input.url : input), init });
      const next = responses[Math.min(seen.length - 1, responses.length - 1)];
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json", "request-id": `req_${seen.length}` },
      });
    };
    setAiClientFactory((apiKey) => createAnthropicClient(apiKey, { fetch: fetchImpl, maxRetries: 0 }));
    return seen;
  }

  it("serialises the request with the API key only and parses the response", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "ambient-oauth-token";
    const { listing } = await seedFixture();
    const seen = installFetch([{ status: 200, body: jsonMessage(ANSWER) }]);

    const row = await evaluateListing(db, listing.id);

    expect(row.verdict).toBe("good");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(seen[0].init?.headers);
    expect(headers.get("x-api-key")).toBe(API_KEY);
    expect(headers.get("authorization")).toBeNull();
    const body = JSON.parse(String(seen[0].init?.body));
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.messages[0].content[0]).toEqual({ type: "image", source: { type: "url", url: "https://images.example/ps5-1.jpg" } });
  });

  it("falls back to text-only when the API answers 400 for an image URL", async () => {
    const { listing } = await seedFixture();
    const seen = installFetch([
      { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Could not process image" } } },
      { status: 200, body: jsonMessage(ANSWER) },
    ]);
    const row = await evaluateListing(db, listing.id);
    expect(row.dealScore).toBe(72);
    expect(seen).toHaveLength(2);
    const retried = JSON.parse(String(seen[1].init?.body));
    expect(retried.messages[0].content.every((b: { type: string }) => b.type === "text")).toBe(true);
  });
});

describe("evaluateMatchEvents", () => {
  it("evaluates non-silent events of AI-enabled searches and collects failures", async () => {
    const { search, listing } = await seedFixture();
    const manual = await seedSearch(db, { name: "Manual only", aiEvaluate: false });
    const second = await seedListing(db, { imageUrls: [] });
    const broken = await seedListing(db, { title: "broken", imageUrls: [] });
    await seedMatch(db, manual.id, listing.id);
    await seedMatch(db, search.id, second.id);
    await seedMatch(db, search.id, broken.id);

    useFake((body) => {
      if (userText({ body }).includes('"title": "broken"')) throw apiError(500, "api_error", "Internal server error");
      return jsonMessage(ANSWER);
    });

    const event = (listingId: number, searchId: number, silent = false) => ({ type: "new" as const, matchId: 0, searchId, listingId, silent });
    const result = await evaluateMatchEvents(db, [
      event(listing.id, search.id),
      event(listing.id, search.id), // duplicate
      event(listing.id, manual.id), // search without aiEvaluate
      event(second.id, search.id, true), // silent
      event(broken.id, search.id),
    ]);

    expect(result.evaluations.map((e) => e.listingId)).toEqual([listing.id]);
    expect(result.errors).toEqual([{ listingId: broken.id, searchId: search.id, error: "Claude API error 500 api_error: Internal server error" }]);
    expect(fake.calls).toHaveLength(2);
  });

  it("is a no-op when AI is not configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { search, listing } = await seedFixture();
    await db.update(searches).set({ aiEvaluate: true }).where(eq(searches.id, search.id));
    useFake(() => jsonMessage(ANSWER));
    const result = await evaluateMatchEvents(db, [{ type: "new", matchId: 1, searchId: search.id, listingId: listing.id, silent: false }]);
    expect(result).toEqual({ evaluations: [], errors: [] });
    expect(fake.calls).toHaveLength(0);
  });
});
