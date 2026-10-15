-- The scanner sends no registration postback to a partner network; the
-- dashboard is the one sender of that report. The click id a registration
-- request kept for it is dropped, and the partner_tracker destination leaves
-- the delivery outbox. Applying this deletes the click id every request kept,
-- finished or still waiting for its link, and every outbox row bound for the
-- partner, delivered or not. The destination passes through text before those
-- rows are deleted, so the delete names no value of the enum: a database that
-- last migrated before partner_tracker was added adds it and removes it in one
-- transaction, and an enum value cannot be used in the transaction that added
-- it.
ALTER TABLE "delivery_outbox" ALTER COLUMN "destination" SET DATA TYPE text;--> statement-breakpoint
DELETE FROM "delivery_outbox" WHERE "destination" = 'partner_tracker';--> statement-breakpoint
DROP TYPE "public"."delivery_destination";--> statement-breakpoint
CREATE TYPE "public"."delivery_destination" AS ENUM('posthog', 'meta');--> statement-breakpoint
ALTER TABLE "delivery_outbox" ALTER COLUMN "destination" SET DATA TYPE "public"."delivery_destination" USING "destination"::"public"."delivery_destination";--> statement-breakpoint
ALTER TABLE "registration_intents" DROP COLUMN "partner_click_id_ciphertext";
