CREATE TABLE "cabinet_report_deletion_tombstones" (
	"operation_id" text PRIMARY KEY NOT NULL,
	"operation_digest" text NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cabinet_report_deletion_tombstones_result" CHECK ("cabinet_report_deletion_tombstones"."result" in ('deleted', 'already_absent', 'retained'))
);
--> statement-breakpoint
CREATE TABLE "cabinet_report_identity_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"digest_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cabinet_report_identity_secrets_singleton" CHECK ("cabinet_report_identity_secrets"."id" = 'digest-v1'),
	CONSTRAINT "cabinet_report_identity_secrets_key_length" CHECK (length("cabinet_report_identity_secrets"."digest_key") = 43)
);
--> statement-breakpoint
CREATE TABLE "cabinet_report_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"email_hash" text NOT NULL,
	"state_hash" text NOT NULL,
	"intent_kind" text NOT NULL,
	"status" text NOT NULL,
	"consumed_at" timestamp with time zone NOT NULL,
	"completion_deadline" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"issue_attempted_at" timestamp with time zone,
	"issued_link_expires_at" timestamp with time zone,
	"retention_until" timestamp with time zone NOT NULL,
	CONSTRAINT "cabinet_report_receipts_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "cabinet_report_receipts_intent_kind" CHECK ("cabinet_report_receipts"."intent_kind" in ('registration', 'recovery')),
	CONSTRAINT "cabinet_report_receipts_status" CHECK ("cabinet_report_receipts"."status" in ('pending', 'completed', 'invalidated'))
);
--> statement-breakpoint
CREATE INDEX "cabinet_report_receipts_email_idx" ON "cabinet_report_receipts" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "cabinet_report_receipts_retention_idx" ON "cabinet_report_receipts" USING btree ("retention_until");
