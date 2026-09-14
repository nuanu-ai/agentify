ALTER TYPE "public"."delivery_destination" ADD VALUE 'partner_tracker';--> statement-breakpoint
ALTER TABLE "delivery_outbox" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registration_intents" ADD COLUMN "partner_click_id_ciphertext" text;