-- Drops what browser_observations kept of the browser observer's signals,
-- decided 2026-09-28. The Actor's output no longer carries a signals object:
-- nothing read it, and two of its limits failed whole runs, a page past 1,000
-- requests and a cookie wall. The signals column held that object, and
-- request_count and transferred_bytes were copies of two of its fields that
-- nothing read either; for every run that observed a page, the same two
-- numbers stay in the evidence of its browser_runtime_cost finding.
-- duration_ms stays, since it comes from the output's timings. Applying this
-- deletes the stored signals and the two counts of every observation so far.
ALTER TABLE "browser_observations" DROP COLUMN "request_count";--> statement-breakpoint
ALTER TABLE "browser_observations" DROP COLUMN "transferred_bytes";--> statement-breakpoint
ALTER TABLE "browser_observations" DROP COLUMN "signals";