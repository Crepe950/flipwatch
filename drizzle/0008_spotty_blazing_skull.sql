CREATE TABLE "blocked_sellers" (
	"id" serial PRIMARY KEY NOT NULL,
	"marketplace" text NOT NULL,
	"seller_key" text NOT NULL,
	"seller_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_sellers_marketplace_key_idx" ON "blocked_sellers" USING btree ("marketplace","seller_key");