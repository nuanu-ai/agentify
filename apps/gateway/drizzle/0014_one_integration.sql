-- A merchant sells through one integration at a time, and every card says
-- which integration published it (ADR-0036).
--
-- Nothing recorded the integration before this, so the cards already there
-- are recorded by their merchant item id: `woo_`, sixteen hex digits, an
-- underscore and a product number is the one shape the dashboard's import
-- writes (`merchantItemIdFor`), and everything else came through the API. A
-- merchant with an imported card starts on the shop, which is where their
-- orders went whenever the shop's worker drew them first; every other
-- merchant starts on their code. The live channel never offered the
-- connector, so it holds no imported card and every merchant there stays on
-- the API.
ALTER TABLE "cards" ADD COLUMN "integration" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
UPDATE "cards" SET "integration" = 'woocommerce' WHERE "merchant_item_id" ~ '^woo_[0-9a-f]{16}_[0-9]+$';--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "integration" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "integration" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
UPDATE "merchants" SET "integration" = 'woocommerce' WHERE EXISTS (SELECT 1 FROM "cards" WHERE "cards"."merchant_id" = "merchants"."id" AND "cards"."integration" = 'woocommerce');--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_integration_known" CHECK ("cards"."integration" in ('api', 'woocommerce'));--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_integration_known" CHECK ("merchants"."integration" in ('api', 'woocommerce'));
