import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, createTestDb } from "@/lib/db";
import { listings, searches } from "@/lib/db/schema";
import { DEFAULT_LOCATION } from "@/lib/locations";

describe("database scaffold", () => {
  it("migrates an in-memory database and round-trips rows", async () => {
    const { db, close } = await createTestDb();
    try {
      const [s] = await db
        .insert(searches)
        .values({ name: "PS5", query: "ps5", marketplaces: ["craigslist"], location: DEFAULT_LOCATION })
        .returning();
      expect(s.id).toBeGreaterThan(0);
      expect(s.excludeTerms).toEqual([]);
      expect(s.location.label).toBe("Vancouver, BC");

      await db.insert(listings).values({ marketplace: "craigslist", externalId: "1", url: "https://x", title: "PS5", priceCents: 30000 });
      const rows = await db.select().from(listings);
      expect(rows).toHaveLength(1);
      expect(rows[0].imageUrls).toEqual([]);
    } finally {
      await close();
    }
  });

  it("backfills deals.stage_changed_at from the per-stage timestamps when adding it (0001)", async () => {
    const [init, stageChangedAt] = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
    const pg = new PGlite();
    try {
      for (const statement of init.sql) await pg.exec(statement);
      await pg.exec(`
        insert into listings (id, marketplace, external_id, url, title) values
          (1, 'craigslist', '1', 'https://x/1', 'a'), (2, 'craigslist', '2', 'https://x/2', 'b'),
          (3, 'craigslist', '3', 'https://x/3', 'c'), (4, 'craigslist', '4', 'https://x/4', 'd'),
          (5, 'craigslist', '5', 'https://x/5', 'e');
        insert into deals (listing_id, stage, created_at, updated_at, contacted_at, purchased_at, sold_at) values
          (1, 'lead',        '2026-01-01Z', '2026-01-09Z', null, null, null),
          (2, 'contacted',   '2026-01-01Z', '2026-01-09Z', '2026-01-02Z', null, null),
          (3, 'purchased',   '2026-01-01Z', '2026-01-09Z', '2026-01-02Z', '2026-01-03Z', null),
          (4, 'sold',        '2026-01-01Z', '2026-01-09Z', '2026-01-02Z', '2026-01-03Z', '2026-01-04Z'),
          (5, 'negotiating', '2026-01-01Z', '2026-01-09Z', '2026-01-02Z', null, null);
      `);
      for (const statement of stageChangedAt.sql) await pg.exec(statement);
      const { rows } = await pg.query<{ stage: string; at: string }>(
        "select stage, to_char(stage_changed_at at time zone 'UTC', 'YYYY-MM-DD') as at from deals order by listing_id",
      );
      expect(rows).toEqual([
        { stage: "lead", at: "2026-01-01" },
        { stage: "contacted", at: "2026-01-02" },
        { stage: "purchased", at: "2026-01-03" },
        { stage: "sold", at: "2026-01-04" },
        { stage: "negotiating", at: "2026-01-09" },
      ]);
    } finally {
      await pg.close();
    }
  });
});
