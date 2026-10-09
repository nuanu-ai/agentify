-- An account names its merchant by the identifier alone.
--
-- The key kept beside the identifier was the credential the dashboard called
-- the gateway with. The two run in one process and the dashboard holds no key
-- (ADR-0030), and the gateway deletes the keys made for a dashboard in its own
-- migration, so the column holds secrets that open nothing and is dropped,
-- together with the check that held the identifier and the key to both or
-- neither. What that check also refused, an empty identifier, stays refused.
-- Which accounts have a merchant is unchanged: every row keeps its
-- `merchant_id`.
--
-- One way: a database migrated by this has no keys to give back.
ALTER TABLE "dashboard_accounts" DROP CONSTRAINT "dashboard_accounts_complete_merchant";--> statement-breakpoint
ALTER TABLE "dashboard_accounts" DROP COLUMN "merchant_key";--> statement-breakpoint
ALTER TABLE "dashboard_accounts" ADD CONSTRAINT "dashboard_accounts_merchant_named" CHECK ("dashboard_accounts"."merchant_id" is null or "dashboard_accounts"."merchant_id" <> '');