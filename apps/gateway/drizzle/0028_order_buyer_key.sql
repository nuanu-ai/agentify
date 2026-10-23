-- Every order's buyer's key, and the order a key opens, found by it.
--
-- The agent's read of its own purchase finds the order by a key kept inside
-- the order's document and never by the order's identifier, which reaches the
-- merchant, their shop and the payment side.
--
-- The first statement gives every order written before keys existed one of
-- its own, random as the gateway issues them: `bk_` and the 32 hex digits of
-- a version-4 UUID, which PostgreSQL draws from a strong random source. Only
-- documents without one are touched, and only the key is written. Nobody holds
-- these keys: such an order's buyer was handed an address built from its
-- identifier, which opens nothing any more.
--
-- The second makes the lookup an index read and refuses two orders under one
-- key. It is built in the migration's transaction and holds writes to orders
-- while it is built, which on today's tables is a moment.
UPDATE "orders"
SET "record" = jsonb_set(
  "record",
  '{buyerKey}',
  to_jsonb('bk_' || replace(gen_random_uuid()::text, '-', ''))
)
WHERE "record" ->> 'buyerKey' IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_buyer_key_unique" ON "orders" USING btree (("record" ->> 'buyerKey'));
