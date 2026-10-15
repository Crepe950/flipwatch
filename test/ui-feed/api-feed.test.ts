import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Db } from "@/lib/db";
import type { FeedApiResponse } from "@/lib/queries/feed";
import { insertListing, insertMatch, insertSearch } from "./fixtures";

const state = vi.hoisted(() => ({ db: null as Db | null }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: async () => state.db! };
});

const { createTestDb } = await import("@/lib/db");
const { GET } = await import("@/app/api/feed/route");

let close: () => Promise<void>;

beforeAll(async () => {
  const test = await createTestDb();
  state.db = test.db;
  close = test.close;
  const search = await insertSearch(test.db, "PS5");
  const base = Date.parse("2026-09-28T12:00:00.000Z");
  for (let i = 0; i < 3; i++) {
    const l = await insertListing(test.db, { title: `PS5 #${i}`, marketplace: i === 0 ? "kijiji" : "craigslist" });
    await insertMatch(test.db, search.id, l.id, { lastEventAt: new Date(base - i * 60_000) });
  }
});

afterAll(async () => {
  await close();
});

const get = (qs: string) => GET(new NextRequest(`http://localhost/api/feed${qs}`));

describe("GET /api/feed", () => {
  it("rejects invalid parameters with 400 and the offending path", async () => {
    const res = await get("?score=abc&marketplace=amazon");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.map((i: { path: string }) => i.path).sort()).toEqual(["marketplace", "score"]);
  });

  it("rejects malformed cursors", async () => {
    expect((await get("?cursor=garbage")).status).toBe(400);
    expect((await get("?cursor=garbage&since=2026-09-28T12:00:00Z")).status).toBe(400);
  });

  it("pages through the feed with a cursor", async () => {
    const res = await get("?limit=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const first = (await res.json()) as FeedApiResponse;
    expect(first.items.map((i) => i.title)).toEqual(["PS5 #0", "PS5 #1"]);
    expect(first.unseenCount).toBe(3);
    const second = (await (await get(`?limit=2&cursor=${first.nextCursor}`)).json()) as FeedApiResponse;
    expect(second.items.map((i) => i.title)).toEqual(["PS5 #2"]);
    expect(second.nextCursor).toBeNull();
  });

  it("polls with since and applies the same filters", async () => {
    const body = (await (await get("?since=2026-09-28T11:59:00.000Z&marketplace=craigslist")).json()) as FeedApiResponse;
    expect(body.items.map((i) => i.title)).toEqual(["PS5 #1"]);
    expect(body.nextCursor).toBeNull();
    expect(body.unseenCount).toBe(2);
  });

  it("pages through a poll window bigger than the limit with since + cursor", async () => {
    const since = "since=2026-09-28T11:57:00.000Z";
    const first = (await (await get(`?${since}&limit=2`)).json()) as FeedApiResponse;
    expect(first.items.map((i) => i.title)).toEqual(["PS5 #0", "PS5 #1"]);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (await get(`?${since}&limit=2&cursor=${first.nextCursor}`)).json()) as FeedApiResponse;
    expect(second.items.map((i) => i.title)).toEqual(["PS5 #2"]);
    expect(second.nextCursor).toBeNull();
  });
});
