-- What the call behind last_used_at said it runs, from its user-agent header,
-- so the team can see which release of the SDK each key is called from. The
-- caller's own claim: it proves nothing, and nothing refuses a call on it.
--
-- Nothing is backfilled: no earlier call was recorded with what it ran, so the
-- column arrives empty and fills as calls come in. Left as drizzle-kit
-- generated it: one nullable column with no default.
ALTER TABLE "merchant_keys" ADD COLUMN "last_user_agent" text;
