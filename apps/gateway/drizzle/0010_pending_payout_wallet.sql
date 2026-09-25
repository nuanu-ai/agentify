-- A replacement payout wallet that waits (ADR-0019).
--
-- On the live deployment a change of an address already set is announced to
-- every account of the merchant first and takes effect forty-eight hours after
-- that, so the row has to hold the address paid now and the one waiting, with
-- the instant it takes over.
--
-- Nothing is backfilled. Every merchant this finds is paid where they were paid
-- the moment before, with nothing waiting, because nothing was announced for
-- any of them; a change found waiting after a migration would be a change
-- nobody was told about. Two nullable columns with no default are statements
-- Postgres takes without rewriting the table, and updated_at does not move.
--
-- The check holds the pair together for anybody writing by hand: an address
-- with no moment is a sale paid somewhere at no stated time, and a moment with
-- no address is a stated time to nowhere. Every existing row satisfies it,
-- since both columns arrive null.
ALTER TABLE "merchants" ADD COLUMN "pending_payout_wallet" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "pending_payout_wallet_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_pending_payout_wallet_whole" CHECK (("merchants"."pending_payout_wallet" is null) = ("merchants"."pending_payout_wallet_from" is null));
