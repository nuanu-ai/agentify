ALTER TABLE "registration_intents" ALTER COLUMN "phone_e164_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "registration_intents" ALTER COLUMN "phone_lookup_hash" DROP NOT NULL;