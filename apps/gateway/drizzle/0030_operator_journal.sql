-- The operator's journal: a row for every administrative action pressed in
-- the operator's workspace and for every refused press at one, which the
-- application only adds to. It names merchants and accounts by identifier with
-- no foreign key, so forgetting a merchant or erasing a person leaves the rows
-- naming them. A row that breaks a check fails the transaction of the action
-- it records.
CREATE TABLE "operator_journal" (
	"sequence" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "operator_journal_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_merchant" text,
	"reason" text,
	"outcome" text NOT NULL,
	"refusal" text,
	CONSTRAINT "operator_journal_actor" CHECK ("operator_journal"."actor_kind" in ('account', 'terminal', 'configuration') and ("operator_journal"."actor_kind" = 'account') = ("operator_journal"."actor_id" is not null)),
	CONSTRAINT "operator_journal_action" CHECK ("action" in ('admit', 'withdraw', 'disable_key', 'end_sessions', 'grant_operator', 'remove_operator', 'forget_account', 'first_operator')),
	CONSTRAINT "operator_journal_subject" CHECK (("operator_journal"."subject_kind" = 'merchant' and "operator_journal"."subject_merchant" = "operator_journal"."subject_id") or ("operator_journal"."subject_kind" = 'key' and "operator_journal"."subject_merchant" is not null) or ("operator_journal"."subject_kind" = 'account' and "operator_journal"."subject_merchant" is null)),
	CONSTRAINT "operator_journal_outcome" CHECK ("operator_journal"."outcome" in ('done', 'unchanged', 'refused') and ("operator_journal"."outcome" = 'refused') = ("operator_journal"."refusal" is not null)),
	CONSTRAINT "operator_journal_reason" CHECK ("reason" is null or (char_length("reason") between 1 and 2000))
);
--> statement-breakpoint
CREATE INDEX "operator_journal_merchant_idx" ON "operator_journal" USING btree ("subject_merchant","sequence") WHERE "operator_journal"."subject_merchant" is not null;--> statement-breakpoint
CREATE INDEX "operator_journal_account_idx" ON "operator_journal" USING btree ("subject_id","sequence") WHERE "operator_journal"."subject_kind" = 'account';