-- The keys made for a dashboard are deleted, and the column that told them
-- apart goes with them.
--
-- The dashboard calls the gateway inside the process the two share and holds
-- no key (ADR-0030). Every row whose purpose is `dashboard` is a credential
-- nothing calls with that still opens the API — the one written at
-- registration and any a renewal left behind — so they are removed rather
-- than revoked: nobody ever saw one, and nobody will ask when it stopped.
-- What remains is the merchant's own keys, and a column with one value left
-- in it says nothing.
--
-- One way: a database migrated by this has no dashboard keys to give back.
DELETE FROM "merchant_keys" WHERE "purpose" = 'dashboard';--> statement-breakpoint
ALTER TABLE "merchant_keys" DROP COLUMN "purpose";
