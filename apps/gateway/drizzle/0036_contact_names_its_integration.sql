-- A merchant's last poll names the integration that made it, and counts only
-- while the merchant sells through that one (ADR-0043). Until this, only the
-- merchant's own code wrote a poll down, so every row already here is the
-- code's.
ALTER TABLE "merchant_contact" ADD COLUMN "integration" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_contact" ALTER COLUMN "integration" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "merchant_contact" ADD CONSTRAINT "merchant_contact_integration_known" CHECK ("merchant_contact"."integration" in ('api', 'woocommerce'));
