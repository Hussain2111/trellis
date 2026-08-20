CREATE TABLE "generations" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"week_start" text NOT NULL,
	"payload" jsonb NOT NULL,
	"output" jsonb,
	"status" text DEFAULT 'ok' NOT NULL,
	"validation_notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "generations_kind_week_uq" ON "generations" USING btree ("kind","week_start");--> statement-breakpoint
CREATE INDEX "generations_created_idx" ON "generations" USING btree ("created_at");