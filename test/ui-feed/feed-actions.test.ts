import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";
import { searchMatches } from "@/lib/db/schema";
import { insertListing, insertMatch, insertSearch } from "./fixtures";

const state = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: async () => state.db! };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createTestDb } = await import("@/lib/db");
const { markAllSeenAction } = await import("@/components/feed/actions");

let close: () => Promise<void>;
beforeAll(async () => {
  ({ db: state.db, close } = await createTestDb());
});
afterAll(() => close());

describe("markAllSeenAction", () => {
  it("only marks what the filtered feed shows as unseen", async () => {
    const db = state.db!;
    const ps5 = await insertSearch(db, "PS5");
    const aeron = await insertSearch(db, "Aeron");
    const shown = await insertMatch(db, ps5.id, (await insertListing(db, { title: "PS5 slim" })).id);
    const hidden = await insertMatch(db, aeron.id, (await insertListing(db, { title: "Aeron chair" })).id);

    await expect(markAllSeenAction(`search=${ps5.id}`)).resolves.toEqual({ ok: true, count: 1 });
    const seen = Object.fromEntries((await db.select().from(searchMatches)).map((m) => [m.id, m.seen]));
    expect(seen).toEqual({ [shown.id]: true, [hidden.id]: false });
  });

  it("rejects filters it can't parse instead of marking everything", async () => {
    await expect(markAllSeenAction("marketplace=amazon")).resolves.toEqual({ ok: false, error: "Invalid filters" });
    await expect(markAllSeenAction(42 as unknown as string)).resolves.toEqual({ ok: false, error: "Invalid filters" });
  });
});
