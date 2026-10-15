import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as dbModule from "@/lib/db";
import { GET as healthGET } from "@/app/api/health/route";
import { GET as cronGET, POST as cronPOST, maxDuration } from "@/app/api/cron/tick/route";
import { scrapeRuns } from "@/lib/db/schema";
import { readHeartbeat } from "../heartbeat";
import { insertSearch, resetDb } from "./helpers";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: vi.fn() };
});
// Never let a route test reach a real marketplace: every search runs against an offline adapter.
const offlineAdapter = vi.hoisted(() => ({
  id: "ebay" as const,
  displayName: "Offline eBay",
  countries: [] as string[],
  minIntervalSec: 0,
  status: () => ({ ok: true }),
  buildSearchUrl: () => "",
  search: async () => [],
}));
vi.mock("@/lib/marketplaces/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketplaces/registry")>();
  return { ...actual, getAdapter: () => offlineAdapter };
});
vi.mock("@/lib/notify", () => ({ notifyMatchEvents: vi.fn(async () => {}) }));
vi.mock("@/lib/ai", () => ({ aiStatus: () => ({ configured: false, model: "" }), evaluateListing: vi.fn() }));

let db: dbModule.Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await dbModule.createTestDb());
});

beforeEach(async () => {
  await resetDb(db);
  vi.mocked(dbModule.getDb).mockResolvedValue(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => close());

const cronRequest = (method: "GET" | "POST", authorization?: string) =>
  new Request("http://localhost/api/cron/tick", { method, headers: authorization ? { authorization } : {} });

describe("GET/POST /api/cron/tick", () => {
  it("is closed when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await cronGET(cronRequest("GET", "Bearer anything"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "Forbidden" });
  });

  it("rejects a wrong or missing secret", async () => {
    vi.stubEnv("CRON_SECRET", "right");
    expect((await cronGET(cronRequest("GET", "Bearer wrong"))).status).toBe(403);
    expect((await cronPOST(cronRequest("POST"))).status).toBe(403);
    expect(dbModule.getDb).not.toHaveBeenCalled();
  });

  it("runs a tick with the right secret and reports what ran", async () => {
    vi.stubEnv("CRON_SECRET", "right");
    const search = await insertSearch(db, { marketplaces: ["ebay"] });
    const res = await cronPOST(cronRequest("POST", "Bearer right"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, ranSearchIds: [search.id], errors: [] });
    expect(typeof body.durationMs).toBe("number");
    expect(await readHeartbeat(db)).toMatchObject({ mode: "cron" });
    expect(await db.select().from(scrapeRuns)).toEqual([expect.objectContaining({ searchId: search.id, error: null })]);
    expect(maxDuration).toBe(60);
  });

  it("returns 500 when the database is unavailable", async () => {
    vi.stubEnv("CRON_SECRET", "right");
    vi.mocked(dbModule.getDb).mockRejectedValueOnce(new Error("connection refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await cronGET(cronRequest("GET", "Bearer right"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "Tick failed" });
  });
});

describe("GET /api/health", () => {
  it("returns the health summary without caching", async () => {
    vi.stubEnv("WORKER_MODE", "off");
    await insertSearch(db);
    const res = await healthGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, workerMode: "off", searches: { enabled: 1, total: 1 } });
    expect(body.marketplaces.map((m: { marketplace: string }) => m.marketplace)).toEqual([
      "craigslist",
      "kijiji",
      "ebay",
      "offerup",
      "facebook",
    ]);
  });

  it("returns 503 when the database is unavailable", async () => {
    vi.mocked(dbModule.getDb).mockRejectedValueOnce(new Error("connection refused"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await healthGET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: "Database unavailable" });
  });
});
