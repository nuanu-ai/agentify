-- Drops scanner data that nothing reads. A scan's platform fingerprint was
-- written for every finished scan and read by nobody; the report's own
-- platform check carries no fingerprint evidence. A lead's account id from
-- the former sign-in provider, its name and its volume bucket, a session's
-- country and a consent snapshot's country are no longer written by
-- anything. Applying this deletes every stored fingerprint and whatever
-- older rows still hold in those columns.
ALTER TABLE "scan_fingerprints" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "scan_fingerprints" CASCADE;--> statement-breakpoint
DROP INDEX "leads_supabase_user_id_uidx";--> statement-breakpoint
ALTER TABLE "consent_snapshots" DROP COLUMN "country";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "supabase_user_id";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "leads" DROP COLUMN "volume_bucket";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "geo_country";