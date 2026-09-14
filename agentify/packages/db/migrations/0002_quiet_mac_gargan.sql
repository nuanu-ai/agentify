ALTER TABLE "leads" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scans" ADD COLUMN "idempotency_body_hash" text NOT NULL;