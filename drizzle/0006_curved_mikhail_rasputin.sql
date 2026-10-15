CREATE TABLE "hunts" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_id" integer,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stage" text,
	"result" jsonb,
	"error" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "hunts_created_at_idx" ON "hunts" USING btree ("created_at");