-- One payout split per network, merchant and wallet, whatever spelling the
-- wallet is written in.
--
-- A wallet set before splits existed may be stored in lower case, while the
-- gateway records every split's wallet in the checksummed spelling. One
-- address in two spellings is one wallet, so the key compares it in lower
-- case, as the key on the split's own address already does, and the gateway
-- joins a wallet to its split the same way. An index on an expression cannot
-- be a primary key, so the key becomes a unique index; it is built before the
-- primary key goes, so the table is never without one. No row is touched: the
-- gateway has only ever recorded the checksummed spelling, so no two rows
-- differ in case alone.
CREATE UNIQUE INDEX "payout_splits_wallet_unique" ON "payout_splits" USING btree ("network","merchant_id",lower("merchant_wallet"));--> statement-breakpoint
ALTER TABLE "payout_splits" DROP CONSTRAINT "payout_splits_pkey";
