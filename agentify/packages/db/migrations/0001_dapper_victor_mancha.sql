ALTER TABLE "scan_checks" ADD COLUMN "user_impact_code" text;--> statement-breakpoint
ALTER TABLE "scan_checks" ADD COLUMN "fix_code" text;--> statement-breakpoint
ALTER TABLE "scan_checks" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "worker_heartbeat_at" timestamp with time zone;