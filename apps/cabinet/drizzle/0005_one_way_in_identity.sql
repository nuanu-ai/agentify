-- Refuse the cutover before deleting any legacy proof if an account is in a
-- state the new cabinet cannot interpret honestly. Empty present values are as
-- corrupt as a null/non-null mismatch.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cabinet_accounts
    WHERE (merchant_id IS NULL) <> (merchant_key IS NULL)
       OR (merchant_id IS NOT NULL AND merchant_id = '')
       OR (merchant_key IS NOT NULL AND merchant_key = '')
  ) THEN
    RAISE EXCEPTION 'cabinet account has a partial merchant binding';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "cabinet_link_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"email_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cabinet_link_sends_purpose" CHECK ("cabinet_link_sends"."purpose" in ('cabinet', 'report'))
);
--> statement-breakpoint
CREATE INDEX "cabinet_link_sends_address_idx" ON "cabinet_link_sends" USING btree ("email_hash","purpose","sent_at");
--> statement-breakpoint
CREATE INDEX "cabinet_link_sends_expires_idx" ON "cabinet_link_sends" USING btree ("expires_at");
--> statement-breakpoint
-- Password credentials, password/confirmation proofs and every old cabinet
-- session end at the coordinated stopped cutover. Account rows, including the
-- exact email_verified value and merchant pair, are deliberately untouched.
DELETE FROM "cabinet_credentials";
--> statement-breakpoint
DELETE FROM "cabinet_sessions";
--> statement-breakpoint
DELETE FROM "cabinet_verifications";
--> statement-breakpoint
ALTER TABLE "cabinet_accounts" ADD CONSTRAINT "cabinet_accounts_complete_merchant" CHECK ((
  ("cabinet_accounts"."merchant_id" is null and "cabinet_accounts"."merchant_key" is null)
  or
  ("cabinet_accounts"."merchant_id" is not null and "cabinet_accounts"."merchant_key" is not null
    and "cabinet_accounts"."merchant_id" <> '' and "cabinet_accounts"."merchant_key" <> '')
));
