-- Whether an order is an attempt that lapsed unpaid, written from the document
-- on every save as `lapsedAttempt` decides it. The orders already here are
-- marked by the same rule read off their documents: ended rejected or expired,
-- no payment ever verified, nothing presented to pay with and no goods held. A
-- field a document does not carry reads as absent, as it does to the code.
ALTER TABLE "orders" ADD COLUMN "lapsed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "orders" SET "lapsed" = true
WHERE "state" IN ('rejected', 'expired')
  AND "record" -> 'order' ->> 'payment' = 'none'
  AND ("record" -> 'order' ->> 'heldFulfillment') IS DISTINCT FROM 'true'
  AND "record" ->> 'payment' IS NULL
  AND "record" ->> 'paidBy' IS NULL
  AND "record" ->> 'paymentAttempt' IS NULL
  AND "record" ->> 'delivery' IS NULL;--> statement-breakpoint
CREATE INDEX "orders_lapsed_merchant_idx" ON "orders" USING btree ("merchant_id","lapsed","created_at");--> statement-breakpoint
CREATE INDEX "orders_lapsed_idx" ON "orders" USING btree ("updated_at") WHERE "orders"."lapsed";
