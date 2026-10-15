CREATE TABLE "ai_evaluations" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" integer NOT NULL,
	"search_id" integer,
	"model" text NOT NULL,
	"verdict" text NOT NULL,
	"deal_score" integer NOT NULL,
	"estimated_resale_low_cents" integer,
	"estimated_resale_high_cents" integer,
	"suggested_offer_cents" integer,
	"summary" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"red_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"questions_for_seller" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"deal_id" integer NOT NULL,
	"direction" text NOT NULL,
	"body" text NOT NULL,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" integer NOT NULL,
	"stage" text DEFAULT 'lead' NOT NULL,
	"offer_cents" integer,
	"purchase_cents" integer,
	"sale_price_cents" integer,
	"fees_cents" integer,
	"other_costs_cents" integer,
	"notes" text,
	"follow_up_at" timestamp with time zone,
	"contacted_at" timestamp with time zone,
	"purchased_at" timestamp with time zone,
	"sold_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" serial PRIMARY KEY NOT NULL,
	"marketplace" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"price_cents" integer,
	"original_price_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"location_text" text,
	"lat" double precision,
	"lng" double precision,
	"posted_at" timestamp with time zone,
	"seller_name" text,
	"condition" text,
	"status" text DEFAULT 'active' NOT NULL,
	"raw" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_health" (
	"marketplace" text PRIMARY KEY NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"backoff_until" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer,
	"match_id" integer,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" integer NOT NULL,
	"price_cents" integer,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "scrape_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_id" integer,
	"marketplace" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"price_drop_count" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "search_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_id" integer NOT NULL,
	"listing_id" integer NOT NULL,
	"first_matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event" text DEFAULT 'new' NOT NULL,
	"deal_score" integer,
	"deal_score_reason" text,
	"estimated_profit_cents" integer,
	"silent" boolean DEFAULT false NOT NULL,
	"notified_at" timestamp with time zone,
	"seen" boolean DEFAULT false NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "searches" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"exclude_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"title_must_match" boolean DEFAULT false NOT NULL,
	"min_price_cents" integer,
	"max_price_cents" integer,
	"expected_resale_cents" integer,
	"marketplaces" jsonb NOT NULL,
	"location" jsonb NOT NULL,
	"category" text,
	"poll_interval_sec" integer DEFAULT 120 NOT NULL,
	"max_listing_age_hours" integer DEFAULT 24 NOT NULL,
	"notify_channel_ids" jsonb,
	"notify_min_deal_score" integer,
	"notify_price_drops" boolean DEFAULT true NOT NULL,
	"ai_evaluate" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_evaluations" ADD CONSTRAINT "ai_evaluations_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_evaluations" ADD CONSTRAINT "ai_evaluations_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_messages" ADD CONSTRAINT "deal_messages_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_match_id_search_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."search_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_runs" ADD CONSTRAINT "scrape_runs_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_matches" ADD CONSTRAINT "search_matches_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_matches" ADD CONSTRAINT "search_matches_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_evaluations_listing_id_idx" ON "ai_evaluations" USING btree ("listing_id","created_at");--> statement-breakpoint
CREATE INDEX "deal_messages_deal_id_idx" ON "deal_messages" USING btree ("deal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deals_listing_id_idx" ON "deals" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "deals_stage_idx" ON "deals" USING btree ("stage");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_marketplace_external_id_idx" ON "listings" USING btree ("marketplace","external_id");--> statement-breakpoint
CREATE INDEX "listings_first_seen_at_idx" ON "listings" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "notification_log_created_at_idx" ON "notification_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "price_history_listing_id_idx" ON "price_history" USING btree ("listing_id","observed_at");--> statement-breakpoint
CREATE INDEX "scrape_runs_started_at_idx" ON "scrape_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "search_matches_search_listing_idx" ON "search_matches" USING btree ("search_id","listing_id");--> statement-breakpoint
CREATE INDEX "search_matches_last_event_at_idx" ON "search_matches" USING btree ("last_event_at");