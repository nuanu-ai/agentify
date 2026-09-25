-- The scanner keeps no session of its own (ADR-0026 §2): the cabinet holds the
-- one session the site has and the scanner asks it whose a cookie is. Report
-- sessions, the recovery requests that minted them and the receipts of the
-- links the scanner used to consume go. A request now reaches the cabinet by
-- its id, so the state its old callback carried goes too. Applying this signs
-- every report session out; their people sign in again with a link.
ALTER TABLE "report_sessions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scanner_identity_completions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scanner_recovery_intents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "report_sessions" CASCADE;--> statement-breakpoint
DROP TABLE "scanner_identity_completions" CASCADE;--> statement-breakpoint
DROP TABLE "scanner_recovery_intents" CASCADE;--> statement-breakpoint
DROP INDEX "registration_intents_callback_state_uidx";--> statement-breakpoint
ALTER TABLE "registration_intents" DROP COLUMN "callback_state_hash";
