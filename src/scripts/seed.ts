/**
 * Demo data for trying FlipWatch offline: `npm run db:seed`.
 *
 * Skips when searches already exist; `--force` first wipes the app's data tables (searches,
 * listings, matches, AI evaluations, deals, runs). Notification channels, push subscriptions and
 * settings other than the worker heartbeat are left alone. No network access is needed: photos
 * are inline SVG data URIs.
 *
 * The demo searches are created paused and have no successful scrape runs, so turning one on
 * starts like a brand-new search: its first real run records what is already listed silently
 * instead of alerting on every result.
 */
import { loadEnvConfig } from "@next/env";
import { count, eq } from "drizzle-orm";
import { closeDb, getDb, PgliteLockedError, type Db } from "../lib/db";
import {
  aiEvaluations,
  appSettings,
  dealMessages,
  deals,
  listings,
  marketplaceHealth,
  notificationLog,
  priceHistory,
  scrapeRuns,
  searches,
  searchMatches,
  type NewDeal,
  type NewListing,
} from "../lib/db/schema";
import { DEFAULT_LOCATION } from "../lib/locations";
import type { CategoryId, DealStage, MarketplaceId } from "../lib/types";

// Same .env files as `next dev` / `next start` (.env.local, .env, …); real environment variables win.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Deterministic PRNG (mulberry32) so every seed produces the same demo. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(20260928);
const between = (min: number, max: number) => min + random() * (max - min);
const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];

// --- Fixture definitions ----------------------------------------------------------------------

interface SearchSeed {
  key: string;
  name: string;
  query: string;
  marketplaces: MarketplaceId[];
  minPriceCents?: number;
  maxPriceCents?: number;
  expectedResaleCents: number;
  category: CategoryId;
  excludeTerms: string[];
  hue: number;
  items: ItemSeed[];
}

interface ItemSeed {
  title: string;
  priceCents: number;
  /** Original price when the listing has since dropped (one or two drops). */
  dropFrom?: number[];
  condition?: string;
  gone?: boolean;
  noPhotos?: boolean;
  blurb: string;
}

const SEARCH_SEEDS: SearchSeed[] = [
  {
    key: "ps5",
    name: "PS5",
    query: "ps5",
    marketplaces: ["craigslist", "kijiji", "facebook", "ebay"],
    minPriceCents: 20_000,
    maxPriceCents: 60_000,
    expectedResaleCents: 52_000,
    category: "video_games",
    excludeTerms: ["broken", "for parts", "box only"],
    hue: 222,
    items: [
      { title: "PS5 Disc Edition + 2 controllers", priceCents: 38_000, condition: "Used - good", blurb: "Works perfectly, always kept in a smoke-free home. Both DualSense controllers hold a charge." },
      { title: "PlayStation 5 Slim Digital — like new", priceCents: 42_000, condition: "Used - like new", blurb: "Bought in March, barely played. Comes with original box, stand and cables." },
      { title: "Sony PS5 console with Spider-Man 2", priceCents: 45_000, blurb: "Disc version with Spider-Man 2 and one controller. No lowballs please." },
      { title: "PS5 disc, barely used, original box", priceCents: 40_000, dropFrom: [48_000], condition: "Used - like new", blurb: "Moving out of the country, need it gone this week. Price dropped!" },
      { title: "PS5 + PSVR2 bundle, all cables", priceCents: 58_000, condition: "Used - good", blurb: "PSVR2 headset with Sense controllers and charging dock. Great for Gran Turismo." },
      { title: "PS5 Digital Edition (CFI-1015B)", priceCents: 33_000, condition: "Used - good", blurb: "Selling because I mostly play on PC now. Tested and fully working, factory reset." },
      { title: "PlayStation 5 w/ extra controller & charging dock", priceCents: 47_500, blurb: "Includes a second controller (white) and the official charging station." },
      { title: "PS5 slim disc - moving sale", priceCents: 36_000, dropFrom: [45_000, 42_000], blurb: "Moving sale — must go by Sunday. E-transfer or cash on pickup." },
      { title: "PS5 console only, no games", priceCents: 35_000, condition: "Used - fair", noPhotos: true, blurb: "Console + power and HDMI cable. Small scratch on the side panel." },
      { title: "PS5 Pro 2TB — open box", priceCents: 59_900, condition: "Open box", blurb: "Opened to test, used twice. Receipt available." },
    ],
  },
  {
    key: "aeron",
    name: "Herman Miller Aeron",
    query: "herman miller aeron",
    marketplaces: ["craigslist", "kijiji", "facebook"],
    maxPriceCents: 95_000,
    expectedResaleCents: 85_000,
    category: "furniture",
    excludeTerms: ["replica", "inspired"],
    hue: 28,
    items: [
      { title: "Herman Miller Aeron Size B — fully loaded", priceCents: 55_000, condition: "Used - good", blurb: "PostureFit SL, adjustable arms, tilt limiter. Mesh is in great shape." },
      { title: "Aeron chair size C, PostureFit", priceCents: 48_000, condition: "Used - good", blurb: "Tall size C. Minor wear on the armpads, everything works." },
      { title: "Herman Miller Aeron (remastered) graphite", priceCents: 72_000, dropFrom: [80_000], condition: "Used - like new", blurb: "Remastered Aeron, 2 years old. Selling because we moved to a smaller place." },
      { title: "Office chair - Herman Miller Aeron size A", priceCents: 35_000, condition: "Used - fair", blurb: "Size A. Some scuffs on the base, mesh has no tears." },
      { title: "2x Herman Miller Aeron chairs", priceCents: 90_000, condition: "Used - good", blurb: "Pair of size B Aerons from an office closure. Price is for both." },
      { title: "Herman Miller Aeron, lumbar pad, great condition", priceCents: 52_500, condition: "Used - good", blurb: "Lumbar pad version, fully adjustable arms. Can deliver in Vancouver for $20." },
      { title: "Aeron chair B size, some wear on armrests", priceCents: 40_000, condition: "Used - fair", noPhotos: true, blurb: "Armrests are worn but the chair is solid and comfortable." },
      { title: "Herman Miller Aeron Classic", priceCents: 30_000, dropFrom: [38_000], condition: "Used - fair", blurb: "Classic Aeron, tilt and height work. Pickup only." },
      { title: "Herman Miller Aeron Size B", priceCents: 65_000, gone: true, condition: "Used - good", blurb: "Size B, fully loaded. First come first served." },
      { title: "Aeron chair — office liquidation", priceCents: 42_500, condition: "Used - good", blurb: "We have 6 available, size B. Priced per chair, cash only." },
    ],
  },
  {
    key: "drill",
    name: "DeWalt drill",
    query: "dewalt drill",
    marketplaces: ["craigslist", "kijiji", "ebay"],
    maxPriceCents: 25_000,
    expectedResaleCents: 17_000,
    category: "tools",
    excludeTerms: ["parts"],
    hue: 45,
    items: [
      { title: "DeWalt 20V Max drill + impact driver combo", priceCents: 16_000, condition: "Used - good", blurb: "Drill and impact driver, two 2Ah batteries, charger and bag." },
      { title: "DeWalt DCD771 cordless drill w/ 2 batteries", priceCents: 9_000, condition: "Used - good", blurb: "Reliable drill, batteries hold charge well." },
      { title: "DeWalt XR hammer drill DCD996 (tool only)", priceCents: 12_000, condition: "Used - like new", blurb: "Tool only, no battery. Three-speed hammer drill, barely used." },
      { title: "DeWalt 20V drill, charger, bag", priceCents: 8_000, condition: "Used - good", blurb: "Upgraded to a bigger kit, this one still works great." },
      { title: "Dewalt Atomic drill kit", priceCents: 11_000, dropFrom: [13_500], condition: "Used - like new", blurb: "Compact Atomic drill with two batteries. Lowered price." },
      { title: "DeWalt 12V drill driver", priceCents: 6_000, condition: "Used - good", noPhotos: true, blurb: "Small 12V drill, perfect for around the house." },
      { title: "DeWalt corded drill 7.8A", priceCents: 4_000, condition: "Used - fair", blurb: "Corded, never needs charging. Chuck works fine." },
      { title: "DEWALT 20V MAX XR brushless drill DCD791", priceCents: 14_000, condition: "Used - good", blurb: "Brushless XR drill with 5Ah battery." },
      { title: "Dewalt drill + 5Ah battery", priceCents: 13_000, blurb: "Drill with a big 5Ah battery, no charger." },
      { title: "DeWalt 20v drill - new in box", priceCents: 19_500, condition: "New", blurb: "Gift I never used, still sealed." },
    ],
  },
  {
    key: "bike",
    name: "Road bike",
    query: "road bike",
    marketplaces: ["craigslist", "kijiji", "facebook"],
    minPriceCents: 25_000,
    maxPriceCents: 180_000,
    expectedResaleCents: 120_000,
    category: "bikes",
    excludeTerms: ["kids", "bmx"],
    hue: 152,
    items: [
      { title: "Specialized Allez 56cm road bike", priceCents: 65_000, condition: "Used - good", blurb: "Aluminum frame, Shimano Claris. New tires this spring." },
      { title: "Trek Domane AL 2, 54cm", priceCents: 80_000, dropFrom: [95_000], condition: "Used - like new", blurb: "Ridden maybe 300 km. Includes pedals and bottle cages." },
      { title: "Giant Contend 2 road bike (M)", priceCents: 55_000, condition: "Used - good", blurb: "Medium frame, fits 5'8\"–5'11\". Recently tuned." },
      { title: "Cannondale CAAD10 105 groupset 54cm", priceCents: 70_000, condition: "Used - good", blurb: "Classic CAAD10 with 105 11-speed. Light and fast." },
      { title: "Carbon road bike — Cervélo R3, 56", priceCents: 150_000, condition: "Used - good", blurb: "Carbon frame, Ultegra groupset, carbon wheels. Serviced last month." },
      { title: "Norco Search XR (gravel/road) 55cm", priceCents: 110_000, condition: "Used - like new", blurb: "Versatile gravel/road bike, hydraulic disc brakes." },
      { title: "Vintage Peugeot road bike, restored", priceCents: 30_000, condition: "Used - good", noPhotos: true, blurb: "Restored 1980s Peugeot, new cables and bar tape." },
      { title: "Felt FR30 road bike 51cm, Shimano 105", priceCents: 85_000, blurb: "Small frame, 105 groupset. Great first 'real' road bike." },
      { title: "Specialized Tarmac SL6 Sport 54", priceCents: 165_000, condition: "Used - like new", blurb: "Carbon Tarmac, 105 Di2-ready. Garage kept." },
      { title: "Road bike size M - Giant Defy", priceCents: 45_000, condition: "Used - fair", blurb: "Some cosmetic scratches, rides well. Needs a tune-up." },
    ],
  },
];

const NEIGHBOURHOODS = [
  "Kitsilano, Vancouver",
  "Mount Pleasant, Vancouver",
  "Commercial Drive, Vancouver",
  "West End, Vancouver",
  "Yaletown, Vancouver",
  "Fairview, Vancouver",
  "Kerrisdale, Vancouver",
  "Marpole, Vancouver",
  "Metrotown, Burnaby",
  "Brentwood, Burnaby",
  "Richmond",
  "Lonsdale, North Vancouver",
  "Coquitlam",
  "Port Moody",
  "New Westminster",
  "Surrey Central",
  "Langley",
  "Ladner, Delta",
];
const SELLERS = ["Jordan", "Priya S.", "Mike", "Wei L.", "Sarah", "Tom K.", "Ava", "Daniel", "Maria G.", "Chris", "Harjit", "Emily R."];

// --- Builders ---------------------------------------------------------------------------------

function photo(title: string, hue: number, variant: number): string {
  const initial = (title.match(/[A-Za-z0-9]/)?.[0] ?? "?").toUpperCase();
  const light = 44 + variant * 7;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue} 55% ${light}%)"/><stop offset="1" stop-color="hsl(${hue + 30} 60% ${light - 16}%)"/>` +
    `</linearGradient></defs><rect width="640" height="480" fill="url(#g)"/>` +
    `<text x="320" y="250" text-anchor="middle" dominant-baseline="middle" font-family="system-ui,-apple-system,sans-serif" ` +
    `font-size="220" font-weight="700" fill="#ffffff" fill-opacity="0.9">${initial}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function listingUrl(marketplace: MarketplaceId, title: string, id: string): string {
  switch (marketplace) {
    case "craigslist":
      return `https://vancouver.craigslist.org/van/for/d/vancouver-${slug(title)}/${id}.html`;
    case "kijiji":
      return `https://www.kijiji.ca/v-view-details.html?adId=${id}`;
    case "ebay":
      return `https://www.ebay.ca/itm/${id}`;
    case "offerup":
      return `https://offerup.com/item/detail/${id}`;
    case "facebook":
      return `https://www.facebook.com/marketplace/item/${id}/`;
  }
}

function externalIdFor(marketplace: MarketplaceId): string {
  const digits = (n: number) => String(Math.floor(between(10 ** (n - 1), 10 ** n - 1)));
  return marketplace === "facebook" ? digits(16) : marketplace === "ebay" ? digits(12) : digits(10);
}

function money(cents: number): string {
  return `$${Math.round(cents / 100).toLocaleString("en-CA")}`;
}

function scoreFor(priceCents: number, expectedCents: number): { score: number; reason: string; profit: number } {
  const ratio = (expectedCents - priceCents) / expectedCents;
  const score = Math.max(3, Math.min(99, Math.round(50 + ratio * 110)));
  const pct = Math.abs(Math.round(ratio * 100));
  const comps = Math.floor(between(6, 24));
  const reason =
    ratio >= 0
      ? random() < 0.5
        ? `${pct}% below median of ${comps} comps`
        : `${pct}% below your expected resale of ${money(expectedCents)}`
      : `${pct}% above median of ${comps} comps`;
  const fees = Math.round(expectedCents * 0.0008) * 100; // ~8% selling fees, whole dollars
  return { score, reason, profit: expectedCents - priceCents - fees };
}

function followUpOn(now: Date, dayOffset: number): Date {
  // Calendar date of "now + offset" (local), stored as 12:00 UTC like the deal form does.
  const d = new Date(now.getTime() + dayOffset * DAY);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12));
}

// --- Seeding ----------------------------------------------------------------------------------

async function wipe(tx: Tx) {
  await tx.delete(dealMessages);
  await tx.delete(deals);
  await tx.delete(notificationLog);
  await tx.delete(aiEvaluations);
  await tx.delete(searchMatches);
  await tx.delete(priceHistory);
  await tx.delete(scrapeRuns);
  await tx.delete(listings);
  await tx.delete(searches);
  await tx.delete(marketplaceHealth);
  await tx.delete(appSettings).where(eq(appSettings.key, "worker.heartbeat"));
}

interface SeededListing {
  id: number;
  searchKey: string;
  item: ItemSeed;
  marketplace: MarketplaceId;
  firstSeenAt: Date;
}

async function seed(tx: Tx, now: Date) {
  const searchCreatedAt = new Date(now.getTime() - 40 * HOUR);
  const searchIds = new Map<string, number>();
  for (const s of SEARCH_SEEDS) {
    const [row] = await tx
      .insert(searches)
      .values({
        name: s.name,
        query: s.query,
        excludeTerms: s.excludeTerms,
        minPriceCents: s.minPriceCents ?? null,
        maxPriceCents: s.maxPriceCents ?? null,
        expectedResaleCents: s.expectedResaleCents,
        marketplaces: s.marketplaces,
        location: DEFAULT_LOCATION,
        category: s.category,
        pollIntervalSec: 120,
        maxListingAgeHours: 24,
        notifyMinDealScore: 60,
        aiEvaluate: s.key === "ps5",
        // Paused: enabling a demo search makes it poll the real marketplaces.
        enabled: false,
        lastRunAt: new Date(now.getTime() - 1 * MINUTE),
        createdAt: searchCreatedAt,
        updatedAt: searchCreatedAt,
      })
      .returning({ id: searches.id });
    searchIds.set(s.key, row.id);
  }

  // Listings, price history and matches.
  const seeded: SeededListing[] = [];
  let listingCount = 0;
  let matchCount = 0;
  let historyCount = 0;
  for (const s of SEARCH_SEEDS) {
    for (const [i, item] of s.items.entries()) {
      const marketplace = s.marketplaces[i % s.marketplaces.length];
      const externalId = externalIdFor(marketplace);
      // Spread postings over the last two days, newest first-ish, with some jitter.
      const postedAt = new Date(now.getTime() - between(4 * MINUTE, 47 * HOUR));
      // Nothing can be seen before the search existed; older posts were picked up by its first run.
      const firstSeenAt = new Date(
        Math.min(now.getTime() - MINUTE, Math.max(postedAt.getTime(), searchCreatedAt.getTime()) + between(1, 6) * MINUTE),
      );
      const hood = pick(NEIGHBOURHOODS);
      const gone = item.gone === true;
      const lastSeenAt = gone ? new Date(Math.max(firstSeenAt.getTime(), now.getTime() - 5 * HOUR)) : new Date(now.getTime() - between(0, 3) * MINUTE);
      const photoCount = item.noPhotos ? 0 : 1 + (i % 3);
      const originalPrice = item.dropFrom?.[0] ?? item.priceCents;

      const values: NewListing = {
        marketplace,
        externalId,
        url: listingUrl(marketplace, item.title, externalId),
        title: item.title,
        description: `${item.blurb}\n\nPickup near ${hood.split(",")[0]}. Cash or e-transfer.\nPlease message through the app — no holds without a deposit.`,
        priceCents: item.priceCents,
        originalPriceCents: originalPrice,
        currency: "CAD",
        imageUrls: Array.from({ length: photoCount }, (_, v) => photo(item.title, s.hue + i * 7, v)),
        locationText: hood,
        lat: DEFAULT_LOCATION.lat + between(-0.12, 0.12),
        lng: DEFAULT_LOCATION.lng + between(-0.25, 0.25),
        postedAt,
        sellerName: pick(SELLERS),
        condition: item.condition ?? null,
        status: gone ? "gone" : "active",
        raw: { seed: true },
        firstSeenAt,
        lastSeenAt,
      };
      const [listing] = await tx.insert(listings).values(values).returning({ id: listings.id });
      listingCount++;
      seeded.push({ id: listing.id, searchKey: s.key, item, marketplace, firstSeenAt });

      // Price history: first observation, any drops, and a repeat observation of the current price.
      const prices = [...(item.dropFrom ?? []), item.priceCents];
      const span = Math.max(MINUTE, lastSeenAt.getTime() - firstSeenAt.getTime());
      const history = prices.map((priceCents, k) => ({
        listingId: listing.id,
        priceCents,
        observedAt: new Date(firstSeenAt.getTime() + (k === 0 ? 0 : span * (0.35 + 0.25 * k))),
      }));
      if (random() < 0.5) history.push({ listingId: listing.id, priceCents: item.priceCents, observedAt: lastSeenAt });
      await tx.insert(priceHistory).values(history);
      historyCount += history.length;

      const dropped = prices.length > 1;
      const lastEventAt = dropped ? history[prices.length - 1].observedAt : firstSeenAt;
      // Stale posts found on the search's first run are recorded silently (no alert).
      const silent = postedAt.getTime() < searchCreatedAt.getTime() && !dropped;
      const { score, reason, profit } = scoreFor(item.priceCents, s.expectedResaleCents);
      const ageMs = now.getTime() - lastEventAt.getTime();
      await tx.insert(searchMatches).values({
        searchId: searchIds.get(s.key)!,
        listingId: listing.id,
        firstMatchedAt: firstSeenAt,
        lastEventAt,
        lastEvent: dropped ? "price_drop" : "new",
        dealScore: score,
        dealScoreReason: reason,
        estimatedProfitCents: profit,
        silent,
        notifiedAt: silent ? null : lastEventAt,
        seen: silent || ageMs > 6 * HOUR,
        dismissed: s.key === "drill" && (i === 6 || i === 5),
      });
      matchCount++;
    }
  }

  const find = (key: string, index: number) => {
    const found = seeded.find((l) => l.searchKey === key && l.item === SEARCH_SEEDS.find((s) => s.key === key)!.items[index]);
    if (!found) throw new Error(`seed listing ${key}#${index} missing`);
    return found;
  };

  // AI evaluations on three standout listings.
  const evaluations = [
    {
      listing: find("ps5", 5),
      searchKey: "ps5",
      verdict: "great" as const,
      dealScore: 88,
      low: 45_000,
      high: 52_000,
      offer: 30_000,
      summary: "A tested digital PS5 at $330 is well under recent Vancouver sales ($450–$520). Low risk, fast flip.",
      reasons: ["Price ~35% under local comps", "Seller says factory reset and tested", "Digital model sells quickly on Marketplace"],
      redFlags: ["No mention of original box", "Ask when it was bought (warranty)"],
      questions: ["Is the controller included and does it have stick drift?", "Any issues with overheating or fan noise?", "Can I see it powered on at pickup?"],
    },
    {
      listing: find("aeron", 3),
      searchKey: "aeron",
      verdict: "good" as const,
      dealScore: 74,
      low: 55_000,
      high: 70_000,
      offer: 30_000,
      summary: "Size A Aerons are less in demand than size B, but at $350 there is still a comfortable margin after a clean-up.",
      reasons: ["$200+ below typical size A resale", "Mesh reported intact (the costly part)"],
      redFlags: ["Size A has a smaller buyer pool", "Scuffed base may need replacing for top price"],
      questions: ["Does the tilt tension and lock still work?", "Any tears or sagging in the seat mesh?"],
    },
    {
      listing: find("bike", 1),
      searchKey: "bike",
      verdict: "fair" as const,
      dealScore: 58,
      low: 80_000,
      high: 95_000,
      offer: 70_000,
      summary: "Fair price after the drop, but resale headroom is thin for an aluminum Domane unless you can get it near $700.",
      reasons: ["Low mileage and recent drop from $950", "Popular endurance model in 54cm"],
      redFlags: ["Margin disappears at asking price", "Check the frame for crash damage"],
      questions: ["Has it ever been crashed or dropped?", "Would you take $700 cash today?"],
    },
  ];
  for (const e of evaluations) {
    await tx.insert(aiEvaluations).values({
      listingId: e.listing.id,
      searchId: searchIds.get(e.searchKey)!,
      model: "claude-sonnet-4-5",
      verdict: e.verdict,
      dealScore: e.dealScore,
      estimatedResaleLowCents: e.low,
      estimatedResaleHighCents: e.high,
      suggestedOfferCents: e.offer,
      summary: e.summary,
      reasons: e.reasons,
      redFlags: e.redFlags,
      questionsForSeller: e.questions,
      inputTokens: Math.floor(between(1400, 2600)),
      outputTokens: Math.floor(between(350, 650)),
      createdAt: new Date(e.listing.firstSeenAt.getTime() + 2 * MINUTE),
    });
  }

  // Historical flips (older listings no longer in the feed) for sold / listed deals.
  const history = [
    { title: "Herman Miller Aeron size B, graphite", marketplace: "craigslist" as const, price: 45_000, hue: 28, daysAgo: 20 },
    { title: "PS5 Disc + 3 games", marketplace: "facebook" as const, price: 32_000, hue: 222, daysAgo: 11 },
    { title: "Specialized Allez Sport 54cm", marketplace: "kijiji" as const, price: 42_000, hue: 152, daysAgo: 8 },
  ];
  const past: number[] = [];
  for (const h of history) {
    const externalId = externalIdFor(h.marketplace);
    const seenAt = new Date(now.getTime() - h.daysAgo * DAY);
    const [row] = await tx
      .insert(listings)
      .values({
        marketplace: h.marketplace,
        externalId,
        url: listingUrl(h.marketplace, h.title, externalId),
        title: h.title,
        description: "Bought through FlipWatch.",
        priceCents: h.price,
        originalPriceCents: h.price,
        currency: "CAD",
        imageUrls: [photo(h.title, h.hue, 1)],
        locationText: pick(NEIGHBOURHOODS),
        postedAt: seenAt,
        sellerName: pick(SELLERS),
        status: "gone",
        firstSeenAt: seenAt,
        lastSeenAt: new Date(seenAt.getTime() + 6 * HOUR),
      })
      .returning({ id: listings.id });
    await tx.insert(priceHistory).values({ listingId: row.id, priceCents: h.price, observedAt: seenAt });
    past.push(row.id);
    listingCount++;
    historyCount++;
  }

  // Deals in every stage.
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const dealSeeds: Array<{ listingId: number; stage: DealStage; values: Partial<NewDeal>; messages?: Array<[("out" | "in" | "note"), string, boolean?, number?]> }> = [
    { listingId: find("aeron", 0).id, stage: "lead", values: { notes: "Size B, fully loaded — check the PostureFit pad.", createdAt: ago(2 * HOUR) } },
    {
      listingId: find("ps5", 0).id,
      stage: "contacted",
      values: { offerCents: 34_000, contactedAt: ago(5 * HOUR), followUpAt: followUpOn(now, 0), createdAt: ago(6 * HOUR) },
      messages: [["out", "Hi! Is the PS5 still available? I could do $340 cash and pick up tonight in Kitsilano.", true, 5 * HOUR]],
    },
    {
      listingId: find("bike", 1).id,
      stage: "negotiating",
      values: { offerCents: 70_000, contactedAt: ago(20 * HOUR), followUpAt: followUpOn(now, -1), createdAt: ago(22 * HOUR) },
      messages: [
        ["out", "Hi, would you take $700 for the Domane? I can pick up this weekend.", true, 20 * HOUR],
        ["in", "Thanks for reaching out. Lowest I can go is $750.", false, 16 * HOUR],
        ["note", "Frame looks clean in photos. Resale ~$900 in 54cm — $750 is borderline.", false, 15 * HOUR],
      ],
    },
    {
      listingId: find("drill", 3).id,
      stage: "purchased",
      values: { offerCents: 7_000, purchaseCents: 7_500, contactedAt: ago(30 * HOUR), purchasedAt: ago(20 * HOUR), createdAt: ago(31 * HOUR), notes: "Batteries tested OK. List as a kit." },
      messages: [
        ["out", "Hey, I can come by today with $70 for the drill kit?", false, 30 * HOUR],
        ["in", "Make it $75 and it's yours.", false, 29 * HOUR],
      ],
    },
    {
      listingId: past[2],
      stage: "listed",
      values: {
        purchaseCents: 42_000,
        otherCostsCents: 6_000,
        salePriceCents: 72_000,
        contactedAt: ago(8 * DAY),
        purchasedAt: ago(7 * DAY),
        createdAt: ago(8 * DAY),
        followUpAt: followUpOn(now, 2),
        notes: "Tune-up + new tires done. Listed on Marketplace and Kijiji at $720.",
      },
    },
    {
      listingId: past[0],
      stage: "sold",
      values: {
        offerCents: 42_000,
        purchaseCents: 45_000,
        salePriceCents: 78_000,
        feesCents: 0,
        otherCostsCents: 1_500,
        contactedAt: ago(19 * DAY),
        purchasedAt: ago(18 * DAY),
        soldAt: ago(12 * DAY),
        createdAt: ago(20 * DAY),
        notes: "Cleaned the mesh, sold to a local startup.",
      },
    },
    {
      listingId: past[1],
      stage: "sold",
      values: {
        purchaseCents: 32_000,
        salePriceCents: 43_000,
        feesCents: 1_300,
        contactedAt: ago(10 * DAY),
        purchasedAt: ago(9 * DAY),
        soldAt: ago(6 * DAY),
        createdAt: ago(11 * DAY),
      },
    },
    {
      listingId: find("ps5", 9).id,
      stage: "passed",
      values: { offerCents: 48_000, contactedAt: ago(3 * HOUR), createdAt: ago(4 * HOUR), notes: "Seller firm at $599 — no margin." },
      messages: [["in", "Sorry, price is firm.", false, 3 * HOUR]],
    },
  ];
  let messageCount = 0;
  for (const d of dealSeeds) {
    const createdAt = d.values.createdAt ?? now;
    const updatedAt = d.values.soldAt ?? d.values.purchasedAt ?? d.values.contactedAt ?? createdAt;
    const [deal] = await tx
      .insert(deals)
      .values({ ...d.values, listingId: d.listingId, stage: d.stage, createdAt, updatedAt: updatedAt as Date, stageChangedAt: updatedAt as Date })
      .returning({ id: deals.id });
    for (const [direction, body, aiGenerated = false, msAgo = HOUR] of d.messages ?? []) {
      await tx.insert(dealMessages).values({ dealId: deal.id, direction, body, aiGenerated, createdAt: ago(msAgo) });
      messageCount++;
    }
  }

  // Recent scraper activity, marketplace health and a worker heartbeat. The runs are not linked to
  // the demo searches: a successful run would mark them as already primed, so their first real run
  // would alert on everything currently listed instead of recording it silently.
  const runs = SEARCH_SEEDS.flatMap((s) =>
    s.marketplaces.map((m, k) => ({
      searchId: null,
      marketplace: m,
      startedAt: ago((1 + k) * MINUTE + between(0, 30_000)),
      durationMs: Math.floor(between(600, 4_500)),
      resultCount: m === "facebook" ? 0 : Math.floor(between(20, 60)),
      newCount: m === "facebook" ? 0 : Math.floor(between(0, 3)),
      priceDropCount: m === "facebook" ? 0 : Math.floor(between(0, 2)),
      error: m === "facebook" ? "Blocked (403) by facebook" : null,
    })),
  );
  await tx.insert(scrapeRuns).values(runs);
  await tx.insert(marketplaceHealth).values([
    { marketplace: "craigslist", lastSuccessAt: ago(MINUTE) },
    { marketplace: "kijiji", lastSuccessAt: ago(2 * MINUTE) },
    { marketplace: "ebay", lastSuccessAt: ago(2 * MINUTE) },
    {
      marketplace: "facebook",
      consecutiveFailures: 3,
      backoffUntil: new Date(now.getTime() + 15 * MINUTE),
      lastSuccessAt: ago(3 * HOUR),
      lastError: "Blocked (403) by facebook",
      lastErrorAt: ago(MINUTE),
    },
  ]);
  // Same shape the engine's writeHeartbeat() uses.
  const heartbeat = { at: now.toISOString(), pid: process.pid, mode: "seed" };
  await tx
    .insert(appSettings)
    .values({ key: "worker.heartbeat", value: heartbeat, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: heartbeat, updatedAt: now } });

  return {
    searches: SEARCH_SEEDS.length,
    listings: listingCount,
    priceHistory: historyCount,
    matches: matchCount,
    aiEvaluations: evaluations.length,
    deals: dealSeeds.length,
    dealMessages: messageCount,
    scrapeRuns: runs.length,
  };
}

async function main() {
  const force = process.argv.includes("--force");
  const db = await getDb();
  const [{ n }] = await db.select({ n: count() }).from(searches);
  if (Number(n) > 0 && !force) {
    console.log(`Found ${n} existing search(es); nothing seeded. Run with --force to wipe app data and reseed.`);
    return;
  }
  const now = new Date();
  const summary = await db.transaction(async (tx) => {
    if (force) await wipe(tx);
    return seed(tx, now);
  });
  console.log(force ? "Wiped app data and seeded demo data:" : "Seeded demo data:");
  console.table(summary);
  console.log("Notification channels were not touched. Start the app with `npm run dev` and open http://localhost:3000");
  console.log("The demo searches are paused; turn one on to poll the real marketplaces for it.");
}

main()
  .catch((err) => {
    console.error(err instanceof PgliteLockedError ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
