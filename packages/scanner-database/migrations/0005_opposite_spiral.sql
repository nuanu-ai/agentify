ALTER TABLE "leads" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "leads_retention_idx" ON "leads" USING btree ("verified_at","anonymized_at","created_at");