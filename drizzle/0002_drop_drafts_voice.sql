-- Guard: the drops below are the one irreversible step in the v2 migration.
-- Drizzle runs each migration file in a transaction, so a RAISE EXCEPTION here
-- rolls the whole thing back rather than leaving a half-migrated database.
DO $$
DECLARE
	scheduled_count integer;
	migrated_count integer;
	orphan_drafts integer;
BEGIN
	SELECT count(*) INTO scheduled_count FROM "schedule";
	SELECT count(*) INTO migrated_count FROM "calendar_entries";

	IF migrated_count < scheduled_count THEN
		RAISE EXCEPTION
			'Refusing to drop drafts/schedule: % schedule row(s) but only % calendar_entries row(s). The 0001 backfill did not complete.',
			scheduled_count, migrated_count;
	END IF;

	SELECT count(*) INTO orphan_drafts
	  FROM "drafts" d
	 WHERE NOT EXISTS (SELECT 1 FROM "schedule" s WHERE s."draft_id" = d."id");

	IF orphan_drafts > 0 THEN
		RAISE NOTICE
			'Dropping % never-scheduled draft(s). v2 has no draft generation, so these have no destination.',
			orphan_drafts;
	END IF;
END $$;--> statement-breakpoint
DROP TABLE "draft_assets" CASCADE;--> statement-breakpoint
DROP TABLE "drafts" CASCADE;--> statement-breakpoint
DROP TABLE "schedule" CASCADE;--> statement-breakpoint
DROP TABLE "voice_profile" CASCADE;
