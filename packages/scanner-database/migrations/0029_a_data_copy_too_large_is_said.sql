-- A copy request whose copy is too large for the dashboard to take ends at
-- once, with that said, since no later try changes it.
ALTER TABLE "data_copy_requests" DROP CONSTRAINT "data_copy_requests_last_outcome";--> statement-breakpoint
ALTER TABLE "data_copy_requests" ADD CONSTRAINT "data_copy_requests_last_outcome" CHECK ("data_copy_requests"."last_outcome" is null or "data_copy_requests"."last_outcome" in ('refused', 'no_answer', 'too_large'));