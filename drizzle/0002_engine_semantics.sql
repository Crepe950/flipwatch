ALTER TABLE "search_matches" ALTER COLUMN "last_event_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "search_matches" ALTER COLUMN "last_event_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "price_history" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "definition_changed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "scrape_runs_search_success_idx" ON "scrape_runs" USING btree ("search_id","marketplace","started_at") WHERE "scrape_runs"."error" is null;--> statement-breakpoint
CREATE INDEX "search_matches_listing_id_idx" ON "search_matches" USING btree ("listing_id");