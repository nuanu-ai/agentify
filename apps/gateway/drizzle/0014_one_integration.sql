-- A merchant sells through one integration at a time, and every card says
-- which integration published it (ADR-0036).
--
-- Nothing recorded the integration before this, so the cards already there
-- are recorded by their merchant item id: `woo_`, sixteen hex digits, an
-- underscore and a product number is the one shape the dashboard's import
-- writes (`merchantItemIdFor`), and everything else came through the API. A
-- merchant with an imported card starts on the shop, and every other merchant
-- starts on their code. The live channel has offered no connector since
-- 2026-10-10 and has no screen to switch back from, so a live merchant moved to
-- the shop here would be stranded; production held no imported card when this
-- was written (a read-only count of the shape below, 2026-10-11), and the
-- count is taken again before the release that carries this.
ALTER TABLE "cards" ADD COLUMN "integration" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
UPDATE "cards" SET "integration" = 'woocommerce' WHERE "merchant_item_id" ~ '^woo_[0-9a-f]{16}_[0-9]+$';--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "integration" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "integration" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
UPDATE "merchants" SET "integration" = 'woocommerce' WHERE EXISTS (SELECT 1 FROM "cards" WHERE "cards"."merchant_id" = "merchants"."id" AND "cards"."integration" = 'woocommerce');--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_integration_known" CHECK ("cards"."integration" in ('api', 'woocommerce'));--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_integration_known" CHECK ("merchants"."integration" in ('api', 'woocommerce'));
