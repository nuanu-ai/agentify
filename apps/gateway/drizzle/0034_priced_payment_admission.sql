ALTER TABLE "orders" ADD COLUMN "price_offer" jsonb;--> statement-breakpoint
UPDATE "orders"
SET "record" = jsonb_set("record", '{order,timestamps,paymentPresentedAt}', 'null'::jsonb, true)
WHERE NOT ("record" -> 'order' -> 'timestamps' ? 'paymentPresentedAt');--> statement-breakpoint
DROP INDEX "orders_waiting_idx";--> statement-breakpoint
DROP INDEX "orders_lapsed_merchant_idx";--> statement-breakpoint
DROP INDEX "orders_lapsed_idx";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "lapsed";
