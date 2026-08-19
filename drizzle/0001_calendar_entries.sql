CREATE TABLE "calendar_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"format" text DEFAULT 'image' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"hook" text,
	"caption" text DEFAULT '' NOT NULL,
	"hashtags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"ig_media_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analyses" ALTER COLUMN "gap" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "calendar_entries_due_idx" ON "calendar_entries" USING btree ("status","scheduled_for");--> statement-breakpoint
-- Backfill: every scheduled draft becomes a self-contained calendar entry.
-- The content columns that used to live on `drafts` are denormalised onto the
-- new row, and the rendered slide URLs are collapsed into `media_urls`, so
-- nothing here still needs `drafts` or `draft_assets` to be readable.
-- Never-scheduled drafts are intentionally not migrated: v2 has no draft
-- generation, so there is no tab that would ever show them again.
INSERT INTO "calendar_entries" (
	"scheduled_for", "status", "format", "title", "hook", "caption",
	"hashtags", "notes", "media_urls", "attempts", "last_error",
	"ig_media_id", "published_at", "created_at", "updated_at"
)
SELECT
	s."scheduled_for",
	CASE s."status" WHEN 'pending' THEN 'planned' ELSE s."status" END,
	CASE d."format" WHEN 'carousel' THEN 'carousel' WHEN 'reel' THEN 'reel' ELSE 'image' END,
	d."title",
	d."hook",
	d."caption",
	COALESCE(d."hashtags", '[]'::jsonb),
	d."rationale",
	COALESCE((
		SELECT jsonb_agg(a."public_url" ORDER BY a."slide_index" NULLS LAST, a."id")
		  FROM "draft_assets" a
		 WHERE a."draft_id" = d."id"
		   AND a."kind" = 'slide'
		   AND a."public_url" IS NOT NULL
	), '[]'::jsonb),
	s."attempts",
	s."last_error",
	s."ig_media_id",
	s."published_at",
	s."created_at",
	now()
FROM "schedule" s
JOIN "drafts" d ON d."id" = s."draft_id"
ORDER BY s."id";
