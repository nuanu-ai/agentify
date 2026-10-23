-- The payment reference leaves every order, with the index that found orders
-- by it. A payment names its order by the order's identifier now, which opens
-- nothing, so a reference left in a document would be a second name for the
-- order that nothing reads. Only the reference is taken out; the rest of each
-- document, the buyer's key included, is left as it is.
DROP INDEX "orders_payment_ref_unique";--> statement-breakpoint
UPDATE "orders" SET "record" = "record" - 'paymentRef' WHERE "record" ? 'paymentRef';
