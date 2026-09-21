-- Drops the three columns of waitlist_entries that served only the report's
-- survey block, removed with docs/research/31-user-journey.md §3: the ordinal
-- shown as a queue position, the free-text answer and the time it was given.
-- Applying this deletes the answers visitors typed so far; nothing reads them.
-- The table stays: it is the record that a lead registered for a scan.
ALTER TABLE "waitlist_entries" DROP CONSTRAINT "waitlist_entries_answer_length";--> statement-breakpoint
DROP INDEX "waitlist_entries_position_uidx";--> statement-breakpoint
ALTER TABLE "waitlist_entries" DROP COLUMN "position";--> statement-breakpoint
ALTER TABLE "waitlist_entries" DROP COLUMN "pain_answer";--> statement-breakpoint
ALTER TABLE "waitlist_entries" DROP COLUMN "answered_at";