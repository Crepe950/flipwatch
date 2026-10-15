import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type Db } from "../db";
import { listings } from "../db/schema";
import { seedListing } from "../ai/testing/seed";
import type { AdapterContext } from "../marketplaces/types";
import { resetListingDetailsCache, withFullDescription } from "./listing-details";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(() => resetListingDetailsCache());

function pageContext(html: string | (() => never)) {
  const fetchImpl = vi.fn(async () => (typeof html === "string" ? new Response(html, { headers: { "Content-Type": "text/html" } }) : html()));
  const ctx: AdapterContext = { fetch: fetchImpl as unknown as typeof fetch, credentials: {} };
  return { ctx, fetchImpl };
}

const POSTING = `<section id="postingbody">Intel Core i7-2600<br>NVIDIA GeForce GTX 555<br>16GB DDR3 RAM</section>`;

describe("withFullDescription", () => {
  it("stores the description from the listing's page, and reads each page once", async () => {
    const listing = await seedListing(db, { title: "Gaming Desktop PC – i7 / 16GB / GTX", description: null });
    const { ctx, fetchImpl } = pageContext(POSTING);

    const filled = await withFullDescription(db, listing, { ctx });
    expect(filled.description).toBe("Intel Core i7-2600\nNVIDIA GeForce GTX 555\n16GB DDR3 RAM");
    const [row] = await db.select().from(listings).where(eq(listings.id, listing.id));
    expect(row.description).toBe(filled.description);

    await withFullDescription(db, row, { ctx });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a longer description we already have", async () => {
    const listing = await seedListing(db, { description: "A much longer description than the page has, with every spec listed in detail." });
    const { ctx } = pageContext(`<section id="postingbody">short</section>`);
    expect((await withFullDescription(db, listing, { ctx })).description).toBe(listing.description);
  });

  it("carries on with the listing as it was when the page can't be read", async () => {
    const listing = await seedListing(db, { description: null });
    const { ctx } = pageContext(() => {
      throw new TypeError("fetch failed");
    });
    expect(await withFullDescription(db, listing, { ctx })).toEqual(listing);
  });
});
