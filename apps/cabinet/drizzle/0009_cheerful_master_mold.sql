ALTER TABLE "cabinet_woo_orders" ADD COLUMN "facts" jsonb;--> statement-breakpoint
ALTER TABLE "cabinet_woo_shops" ADD COLUMN "revision" text DEFAULT 'legacy' NOT NULL;