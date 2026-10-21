-- Drops the optional card signal, which was switched off on every channel:
-- the record of a saved card and the receipts of the payment provider's
-- webhooks, which nothing else wrote. Both were empty on the deployed
-- channels when the feature was removed. Consent snapshots that name the
-- card_signal category keep it; a read passes over a category the policy does
-- not name.
DROP TABLE "payment_signals" CASCADE;--> statement-breakpoint
DROP TABLE "webhook_receipts" CASCADE;--> statement-breakpoint
DROP TYPE "public"."payment_signal_status";--> statement-breakpoint
DROP TYPE "public"."webhook_receipt_status";