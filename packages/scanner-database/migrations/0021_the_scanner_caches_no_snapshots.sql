-- Drops the snapshot cache, decided 2026-09-28. It was switched off on both
-- channels, yet every scan wrote a snapshot nothing read, and switched on it
-- could not refresh a target after the first day. Every scan now reads the
-- site afresh; the daily limit of scans per target is what spares a site
-- repeated scans. Applying this deletes the stored snapshots and each scan's
-- cache_hit and source_scan_id; nothing reads them.
ALTER TABLE "scan_snapshots" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "scan_snapshots" CASCADE;--> statement-breakpoint
ALTER TABLE "scans" DROP CONSTRAINT "scans_source_scan_id_scans_id_fk";
--> statement-breakpoint
ALTER TABLE "scans" DROP COLUMN "cache_hit";--> statement-breakpoint
ALTER TABLE "scans" DROP COLUMN "source_scan_id";