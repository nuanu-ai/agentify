-- Every order's payment reference, and the order a payment is for, found by it.
--
-- A payment challenge names its order by a reference kept inside the order's
-- document, never by the order's identifier: the challenge reaches the payment
-- facilitator and can be published by a discovery listing, while the
-- identifier opens the order and its goods. A paid request is matched to its
-- order by the reference it carries back.
--
-- The first statement gives every order written before references existed one
-- of its own, random as the gateway issues them: `pay_` and the 32 hex digits
-- of a version-4 UUID. Only documents without the key are touched, and only
-- the key is added. So every order has a reference. A buyer of such an order
-- still holds a challenge that named the order by its identifier, which no
-- payment is matched by any more, so an order waiting for its buyer to pay
-- again is reached only by a payment carrying the new reference.
--
-- The second makes the lookup an index read rather than a read of every
-- document, and refuses two orders under one reference. It is built in the
-- migration's transaction and holds writes to orders while it is built, which
-- on today's tables is a moment.
UPDATE "orders"
SET "record" = jsonb_set(
  "record",
  '{paymentRef}',
  to_jsonb('pay_' || replace(gen_random_uuid()::text, '-', ''))
)
WHERE NOT ("record" ? 'paymentRef');
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_payment_ref_unique" ON "orders" USING btree (("record" ->> 'paymentRef'));
