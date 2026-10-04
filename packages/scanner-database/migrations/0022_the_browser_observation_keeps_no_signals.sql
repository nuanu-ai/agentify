-- Drops what browser_observations kept of the browser observer's signals,
-- decided 2026-09-28. The Actor's output no longer carries a signals object:
-- nothing read it, and two of its limits failed whole runs, a page past 1,000
-- requests and a cookie wall. The signals column held that object, and
-- request_count and transferred_bytes were copies of two of its fields that
-- nothing read either; for every run that observed a page, the same two
-- numbers stay in the evidence of its browser_runtime_cost finding.
-- duration_ms stays, since it comes from the output's timings. Applying this
-- deletes the stored signals and the two counts of every observation so far.
-- The contract becomes browser-public-v2.0.0, and the report and status read
-- only that version: observations made under v1 keep their rows and findings,
-- but no report shows them any more. One under v1 that never reached the Actor
-- is closed as browser_contract_retired, rather than run under v2 for a row no
-- report would read; one whose run was started is refused by its answer's
-- version when the worker reads it.
ALTER TABLE "browser_observations" DROP COLUMN "request_count";--> statement-breakpoint
ALTER TABLE "browser_observations" DROP COLUMN "transferred_bytes";--> statement-breakpoint
ALTER TABLE "browser_observations" DROP COLUMN "signals";--> statement-breakpoint
UPDATE "browser_observations"
SET "status" = 'failed', "failure_code" = 'browser_contract_retired',
  "finished_at" = now(), "updated_at" = now()
WHERE "observation_version" <> 'browser-public-v2.0.0'
  AND "status" IN ('queued', 'starting')
  AND "apify_run_id" IS NULL;