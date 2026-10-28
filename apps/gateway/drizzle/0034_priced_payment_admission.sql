ALTER TABLE "orders" ADD COLUMN "price_offer" jsonb;--> statement-breakpoint
UPDATE "orders"
SET "record" = jsonb_set("record", '{order,timestamps,paymentPresentedAt}', 'null'::jsonb, true)
WHERE NOT ("record" -> 'order' -> 'timestamps' ? 'paymentPresentedAt');--> statement-breakpoint
DROP INDEX "orders_waiting_idx";--> statement-breakpoint
CREATE INDEX "orders_unverified_idx" ON "orders" USING btree ("updated_at")
WHERE "orders"."state" = 'quoted' AND "orders"."price_offer" IS NOT NULL;
