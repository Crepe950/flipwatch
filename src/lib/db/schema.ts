import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  AiVerdict,
  CategoryId,
  DealStage,
  MarketplaceId,
  MatchEventType,
  NotificationChannelType,
  SearchLocation,
} from "../types";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** A saved search ("buy box") that the worker polls and alerts on. */
export const searches = pgTable("searches", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** Free-text query sent to every marketplace. */
  query: text("query").notNull(),
  /** Listings whose title/description contain any of these terms are ignored (case-insensitive). */
  excludeTerms: jsonb("exclude_terms").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** When true, every word of `query` must appear in the listing title (filters marketplace fuzzy matches). */
  titleMustMatch: boolean("title_must_match").notNull().default(false),
  minPriceCents: integer("min_price_cents"),
  maxPriceCents: integer("max_price_cents"),
  /** What the user expects to resell a typical match for; enables profit estimates. */
  expectedResaleCents: integer("expected_resale_cents"),
  marketplaces: jsonb("marketplaces").$type<MarketplaceId[]>().notNull(),
  location: jsonb("location").$type<SearchLocation>().notNull(),
  category: text("category").$type<CategoryId>(),
  pollIntervalSec: integer("poll_interval_sec").notNull().default(120),
  /**
   * Catching up after a gap (search paused, app offline, marketplace failing), listings posted longer ago
   * than this — and after the search's previous successful run — are stored silently (no alert).
   * An older listing that only starts matching now (e.g. its price was cut into range) still alerts.
   */
  maxListingAgeHours: integer("max_listing_age_hours").notNull().default(24),
  /** Channel ids to notify; null means "all enabled channels". */
  notifyChannelIds: jsonb("notify_channel_ids").$type<number[] | null>(),
  /** Only alert when the computed deal score is at least this (null = alert on everything). */
  notifyMinDealScore: integer("notify_min_deal_score"),
  /** Only alert when Claude's evaluation of the listing scores at least this (implies aiEvaluate). */
  notifyMinAiScore: integer("notify_min_ai_score"),
  /**
   * Only alert when a market price check (run automatically for matches that pass the other filters) shows
   * at least this much profit, as a percentage of the asking price. Null = no price-check gate.
   */
  notifyMinProfitPct: integer("notify_min_profit_pct"),
  /** The user's buying strategy for this search, given to Claude with every evaluation (e.g. "value PCs by their parts"). */
  aiInstructions: text("ai_instructions"),
  notifyPriceDrops: boolean("notify_price_drops").notNull().default(true),
  /** Run the AI deal evaluation automatically for new matches. */
  aiEvaluate: boolean("ai_evaluate").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  lastError: text("last_error"),
  /**
   * When the fields that decide which listings match (query, filters, price range, location, category)
   * last changed. Runs before this don't count as the search's first run, so the next run is silent again.
   */
  definitionChangedAt: timestamp("definition_changed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A marketplace listing, deduplicated across searches by (marketplace, external_id). */
export const listings = pgTable(
  "listings",
  {
    id: serial("id").primaryKey(),
    marketplace: text("marketplace").$type<MarketplaceId>().notNull(),
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    priceCents: integer("price_cents"),
    /** Price when first seen; used to show total drop. */
    originalPriceCents: integer("original_price_cents"),
    currency: text("currency").notNull().default("USD"),
    imageUrls: jsonb("image_urls").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    locationText: text("location_text"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    sellerName: text("seller_name"),
    condition: text("condition"),
    status: text("status").$type<"active" | "gone">().notNull().default("active"),
    raw: jsonb("raw"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("listings_marketplace_external_id_idx").on(t.marketplace, t.externalId),
    index("listings_first_seen_at_idx").on(t.firstSeenAt),
  ],
);

/** Every observed price for a listing (first observation included). */
export const priceHistory = pgTable(
  "price_history",
  {
    id: serial("id").primaryKey(),
    listingId: integer("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    priceCents: integer("price_cents"),
    /** Currency of `priceCents` (null on rows written before it was tracked). A change starts a new price baseline. */
    currency: text("currency"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("price_history_listing_id_idx").on(t.listingId, t.observedAt)],
);

/** A listing that matched a search. One row per (search, listing); `lastEvent*` tracks the latest alert-worthy event. */
export const searchMatches = pgTable(
  "search_matches",
  {
    id: serial("id").primaryKey(),
    searchId: integer("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    listingId: integer("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    firstMatchedAt: timestamp("first_matched_at", { withTimezone: true }).notNull().defaultNow(),
    /** Millisecond precision (like JS Dates), so the feed can order, page and poll on the indexed column. */
    lastEventAt: timestamp("last_event_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    lastEvent: text("last_event").$type<MatchEventType>().notNull().default("new"),
    /** For a price_drop event: the price it dropped from (so a retried alert reports the same drop). */
    lastEventPreviousPriceCents: integer("last_event_previous_price_cents"),
    /** 0–100, higher is a better deal. null when there is not enough data. */
    dealScore: integer("deal_score"),
    /** Human-readable explanation of the score, e.g. "32% below median of 14 comps". */
    dealScoreReason: text("deal_score_reason"),
    estimatedProfitCents: integer("estimated_profit_cents"),
    /** True when the match's latest event was recorded without alerting (first run, below min score, catch-up…). */
    silent: boolean("silent").notNull().default(false),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    seen: boolean("seen").notNull().default(false),
    dismissed: boolean("dismissed").notNull().default(false),
  },
  (t) => [
    uniqueIndex("search_matches_search_listing_idx").on(t.searchId, t.listingId),
    index("search_matches_last_event_at_idx").on(t.lastEventAt),
    index("search_matches_listing_id_idx").on(t.listingId),
  ],
);

/** AI (Claude) assessment of a listing. The newest row per listing is the current one. */
export const aiEvaluations = pgTable(
  "ai_evaluations",
  {
    id: serial("id").primaryKey(),
    listingId: integer("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    searchId: integer("search_id").references(() => searches.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    verdict: text("verdict").$type<AiVerdict>().notNull(),
    dealScore: integer("deal_score").notNull(),
    estimatedResaleLowCents: integer("estimated_resale_low_cents"),
    estimatedResaleHighCents: integer("estimated_resale_high_cents"),
    suggestedOfferCents: integer("suggested_offer_cents"),
    summary: text("summary").notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    redFlags: jsonb("red_flags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    questionsForSeller: jsonb("questions_for_seller").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_evaluations_listing_id_idx").on(t.listingId, t.createdAt)],
);

/**
 * Market price check of a listing (and, for computers, its parts) against current marketplace listings.
 * `result` is a PriceCheckResult (src/lib/ai/price-check.ts). The newest row per listing is the current one.
 */
export const priceChecks = pgTable(
  "price_checks",
  {
    id: serial("id").primaryKey(),
    listingId: integer("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    result: jsonb("result").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("price_checks_listing_id_idx").on(t.listingId, t.createdAt)],
);

/**
 * A Deal Hunt chat turn: the user's request, and (once done) Claude's ranked picks from a live marketplace
 * search. `result` is a HuntResult (src/lib/ai/deal-hunt.ts). `parentId` chains follow-ups.
 */
export const hunts = pgTable(
  "hunts",
  {
    id: serial("id").primaryKey(),
    parentId: integer("parent_id"),
    prompt: text("prompt").notNull(),
    /** Where to search; null = the app's default location (Settings) at the time the hunt runs. */
    location: jsonb("location").$type<SearchLocation>(),
    status: text("status").$type<"running" | "done" | "error">().notNull().default("running"),
    /** What it's doing right now, for the chat's progress line. */
    stage: text("stage"),
    result: jsonb("result"),
    error: text("error"),
    model: text("model"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("hunts_created_at_idx").on(t.createdAt)],
);

/**
 * Sellers whose listings are ignored everywhere (resellers, scammers). Matched per marketplace on the
 * normalized seller name (`sellerKey`), since not every marketplace exposes a stable seller id.
 */
export const blockedSellers = pgTable(
  "blocked_sellers",
  {
    id: serial("id").primaryKey(),
    marketplace: text("marketplace").$type<MarketplaceId>().notNull(),
    sellerKey: text("seller_key").notNull(),
    sellerName: text("seller_name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("blocked_sellers_marketplace_key_idx").on(t.marketplace, t.sellerKey)],
);

/** A flip in the CRM pipeline. At most one per listing. */
export const deals = pgTable(
  "deals",
  {
    id: serial("id").primaryKey(),
    listingId: integer("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "restrict" }),
    stage: text("stage").$type<DealStage>().notNull().default("lead"),
    /** When the deal last moved to a different stage (drives "days in stage"). */
    stageChangedAt: timestamp("stage_changed_at", { withTimezone: true }).notNull().defaultNow(),
    offerCents: integer("offer_cents"),
    purchaseCents: integer("purchase_cents"),
    salePriceCents: integer("sale_price_cents"),
    feesCents: integer("fees_cents"),
    otherCostsCents: integer("other_costs_cents"),
    notes: text("notes"),
    followUpAt: timestamp("follow_up_at", { withTimezone: true }),
    contactedAt: timestamp("contacted_at", { withTimezone: true }),
    purchasedAt: timestamp("purchased_at", { withTimezone: true }),
    soldAt: timestamp("sold_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("deals_listing_id_idx").on(t.listingId), index("deals_stage_idx").on(t.stage)],
);

/** Conversation / activity log for a deal. */
export const dealMessages = pgTable(
  "deal_messages",
  {
    id: serial("id").primaryKey(),
    dealId: integer("deal_id")
      .notNull()
      .references(() => deals.id, { onDelete: "cascade" }),
    /** out = we sent it, in = seller replied, note = internal note. */
    direction: text("direction").$type<"out" | "in" | "note">().notNull(),
    body: text("body").notNull(),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("deal_messages_deal_id_idx").on(t.dealId, t.createdAt)],
);

/** Where alerts go. `config` shape depends on `type` (see src/lib/notify/channel-types.ts). */
export const notificationChannels = pgTable("notification_channels", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").$type<NotificationChannelType>().notNull(),
  config: jsonb("config").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  enabled: boolean("enabled").notNull().default(true),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: createdAt(),
});

/** Browser Web Push subscriptions (used by channels of type "webpush"). */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
});

/** Delivery log for alerts. */
export const notificationLog = pgTable(
  "notification_log",
  {
    id: serial("id").primaryKey(),
    channelId: integer("channel_id").references(() => notificationChannels.id, { onDelete: "cascade" }),
    matchId: integer("match_id").references(() => searchMatches.id, { onDelete: "cascade" }),
    status: text("status").$type<"sent" | "failed">().notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("notification_log_created_at_idx").on(t.createdAt)],
);

/** One row per (search, marketplace) fetch — powers the health page. */
export const scrapeRuns = pgTable(
  "scrape_runs",
  {
    id: serial("id").primaryKey(),
    searchId: integer("search_id").references(() => searches.id, { onDelete: "cascade" }),
    marketplace: text("marketplace").$type<MarketplaceId>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer("duration_ms").notNull().default(0),
    resultCount: integer("result_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    priceDropCount: integer("price_drop_count").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    index("scrape_runs_started_at_idx").on(t.startedAt),
    // Each run looks up the search's last successful run per marketplace (first-run silence).
    index("scrape_runs_search_success_idx").on(t.searchId, t.marketplace, t.startedAt).where(sql`${t.error} is null`),
  ],
);

/** Per-marketplace backoff state shared by all worker processes. */
export const marketplaceHealth = pgTable("marketplace_health", {
  marketplace: text("marketplace").$type<MarketplaceId>().primaryKey(),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  backoffUntil: timestamp("backoff_until", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
});

/** Small key/value store for app settings (default location, AI toggles, worker heartbeat…). */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

export type Search = typeof searches.$inferSelect;
export type NewSearch = typeof searches.$inferInsert;
export type Listing = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;
export type PriceHistoryRow = typeof priceHistory.$inferSelect;
export type SearchMatch = typeof searchMatches.$inferSelect;
export type AiEvaluation = typeof aiEvaluations.$inferSelect;
export type PriceCheckRow = typeof priceChecks.$inferSelect;
export type HuntRow = typeof hunts.$inferSelect;
export type BlockedSeller = typeof blockedSellers.$inferSelect;
export type Deal = typeof deals.$inferSelect;
export type NewDeal = typeof deals.$inferInsert;
export type DealMessage = typeof dealMessages.$inferSelect;
export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type ScrapeRun = typeof scrapeRuns.$inferSelect;
export type MarketplaceHealth = typeof marketplaceHealth.$inferSelect;
