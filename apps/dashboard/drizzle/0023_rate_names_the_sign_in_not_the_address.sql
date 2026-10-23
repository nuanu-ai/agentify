ALTER TABLE "dashboard_woo_rates" ADD COLUMN "session_signed_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dashboard_woo_rates" DROP COLUMN "set_by";