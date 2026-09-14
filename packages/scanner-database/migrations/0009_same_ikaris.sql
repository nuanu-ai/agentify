ALTER TABLE "browser_observations" ADD COLUMN "usage_reconciled_at" timestamp with time zone;

UPDATE "browser_observations"
SET "usage_reconciled_at" = "finished_at"
WHERE "finished_at" IS NOT NULL
  AND (
    "status" = 'budget_skipped'
    OR (
      "apify_run_id" IS NULL
      AND "budget_reserved_usd" = 0
    )
  );
