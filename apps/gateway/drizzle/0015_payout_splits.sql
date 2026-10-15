-- The registry of payout splits: every split ever named as a payment
-- address, with every parameter the factory creates it from.
--
-- Until a split's first payout these rows are the only place its parameters
-- exist, and without them nobody can create the split or pay out what was
-- paid to it. So a row is never changed or deleted: the trigger below refuses
-- an update and a delete whoever asks, an upsert included, and leaves
-- truncate to the tests that empty a database. There is no foreign key to
-- the merchant, because money may still arrive at a split after a test
-- merchant is forgotten.
--
-- Nothing is backfilled here. A split's address is a Keccak-256 hash, which
-- this SQL cannot compute, so the gateway records the split of every wallet
-- already set when it starts. No merchant and no order is touched: an order
-- verified against a wallet is charged at that wallet, as its payer signed.
CREATE TABLE "payout_splits" (
	"address" text NOT NULL,
	"network" text NOT NULL,
	"merchant_id" text NOT NULL,
	"merchant_wallet" text NOT NULL,
	"commission_wallet" text NOT NULL,
	"merchant_allocation" integer NOT NULL,
	"commission_allocation" integer NOT NULL,
	"total_allocation" integer NOT NULL,
	"distribution_incentive" integer NOT NULL,
	"owner" text NOT NULL,
	"salt" text NOT NULL,
	"factory" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payout_splits_pkey" PRIMARY KEY("network","merchant_id","merchant_wallet")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payout_splits_address_unique" ON "payout_splits" USING btree ("network",lower("address"));
--> statement-breakpoint
CREATE FUNCTION "payout_splits_refuse_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a recorded payout split is never changed or deleted: % on %', OLD.address, OLD.network;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "payout_splits_never_change" BEFORE UPDATE OR DELETE ON "payout_splits" FOR EACH ROW EXECUTE FUNCTION "payout_splits_refuse_change"();
