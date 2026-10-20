ALTER TABLE "payment_claims" ADD COLUMN "retained" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "payment_claims" SET "retained" = true WHERE EXISTS (SELECT 1 FROM "orders" WHERE "orders"."id" = "payment_claims"."order_id" AND "orders"."record" ->> 'payment' IS NOT NULL);--> statement-breakpoint
CREATE INDEX "orders_unresolved_payment_idx" ON "orders" USING btree ("id") WHERE "orders"."record" -> 'order' ->> 'payment' in ('settling', 'outcome_unknown');
