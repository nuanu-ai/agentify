-- The dashboard's tables, and everything named after them, take the dashboard's
-- name. They were made when the dashboard was called the cabinet, and so were
-- their keys, constraints and indexes, which Postgres does not rename with a
-- table. Nothing moves: every statement here is a rename, apart from the log of
-- links sent, for signing in and for reports alike. Its rows are keyed by a hash
-- of the address made with words that carried the old name, and the code now
-- makes it with the new one, so carried over they would count toward no limit
-- and `pnpm forget`, which has to clear an address's rows, would not find them.
-- So the log is emptied: the limits on links, three an hour to one address and
-- one a minute, start again once. The check on its purpose allows `dashboard`
-- in place of `cabinet`.
--
-- The history these migrations keep stays `drizzle.cabinet_migrations`; see
-- `src/database.ts` for why.
ALTER TABLE "cabinet_accounts" RENAME TO "dashboard_accounts";
--> statement-breakpoint
ALTER TABLE "cabinet_credentials" RENAME TO "dashboard_credentials";
--> statement-breakpoint
ALTER TABLE "cabinet_link_sends" RENAME TO "dashboard_link_sends";
--> statement-breakpoint
ALTER TABLE "cabinet_report_deletion_tombstones" RENAME TO "dashboard_report_deletion_tombstones";
--> statement-breakpoint
ALTER TABLE "cabinet_report_identity_secrets" RENAME TO "dashboard_report_identity_secrets";
--> statement-breakpoint
ALTER TABLE "cabinet_sessions" RENAME TO "dashboard_sessions";
--> statement-breakpoint
ALTER TABLE "cabinet_verifications" RENAME TO "dashboard_verifications";
--> statement-breakpoint
ALTER TABLE "cabinet_woo_grants" RENAME TO "dashboard_woo_grants";
--> statement-breakpoint
ALTER TABLE "cabinet_woo_orders" RENAME TO "dashboard_woo_orders";
--> statement-breakpoint
ALTER TABLE "cabinet_woo_quotes" RENAME TO "dashboard_woo_quotes";
--> statement-breakpoint
ALTER TABLE "cabinet_woo_shops" RENAME TO "dashboard_woo_shops";
--> statement-breakpoint
ALTER TABLE "dashboard_accounts" RENAME CONSTRAINT "cabinet_accounts_pkey" TO "dashboard_accounts_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_accounts" RENAME CONSTRAINT "cabinet_accounts_email_unique" TO "dashboard_accounts_email_unique";
--> statement-breakpoint
ALTER TABLE "dashboard_accounts" RENAME CONSTRAINT "cabinet_accounts_complete_merchant" TO "dashboard_accounts_complete_merchant";
--> statement-breakpoint
ALTER TABLE "dashboard_credentials" RENAME CONSTRAINT "cabinet_credentials_pkey" TO "dashboard_credentials_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_credentials" RENAME CONSTRAINT "cabinet_credentials_user_id_cabinet_accounts_id_fk" TO "dashboard_credentials_user_id_dashboard_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "dashboard_link_sends" RENAME CONSTRAINT "cabinet_link_sends_pkey" TO "dashboard_link_sends_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_report_deletion_tombstones" RENAME CONSTRAINT "cabinet_report_deletion_tombstones_pkey" TO "dashboard_report_deletion_tombstones_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_report_deletion_tombstones" RENAME CONSTRAINT "cabinet_report_deletion_tombstones_result" TO "dashboard_report_deletion_tombstones_result";
--> statement-breakpoint
ALTER TABLE "dashboard_report_identity_secrets" RENAME CONSTRAINT "cabinet_report_identity_secrets_pkey" TO "dashboard_report_identity_secrets_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_report_identity_secrets" RENAME CONSTRAINT "cabinet_report_identity_secrets_singleton" TO "dashboard_report_identity_secrets_singleton";
--> statement-breakpoint
ALTER TABLE "dashboard_report_identity_secrets" RENAME CONSTRAINT "cabinet_report_identity_secrets_key_length" TO "dashboard_report_identity_secrets_key_length";
--> statement-breakpoint
ALTER TABLE "dashboard_sessions" RENAME CONSTRAINT "cabinet_sessions_pkey" TO "dashboard_sessions_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_sessions" RENAME CONSTRAINT "cabinet_sessions_token_unique" TO "dashboard_sessions_token_unique";
--> statement-breakpoint
ALTER TABLE "dashboard_sessions" RENAME CONSTRAINT "cabinet_sessions_user_id_cabinet_accounts_id_fk" TO "dashboard_sessions_user_id_dashboard_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "dashboard_verifications" RENAME CONSTRAINT "cabinet_verifications_pkey" TO "dashboard_verifications_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_woo_grants" RENAME CONSTRAINT "cabinet_woo_grants_pkey" TO "dashboard_woo_grants_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_woo_grants" RENAME CONSTRAINT "cabinet_woo_grants_account_id_cabinet_accounts_id_fk" TO "dashboard_woo_grants_account_id_dashboard_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "dashboard_woo_orders" RENAME CONSTRAINT "cabinet_woo_orders_pkey" TO "dashboard_woo_orders_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_woo_orders" RENAME CONSTRAINT "cabinet_woo_orders_account_id_cabinet_accounts_id_fk" TO "dashboard_woo_orders_account_id_dashboard_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "dashboard_woo_quotes" RENAME CONSTRAINT "cabinet_woo_quotes_pkey" TO "dashboard_woo_quotes_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_woo_quotes" RENAME CONSTRAINT "cabinet_woo_quotes_account_id_cabinet_accounts_id_fk" TO "dashboard_woo_quotes_account_id_dashboard_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "dashboard_woo_shops" RENAME CONSTRAINT "cabinet_woo_shops_pkey" TO "dashboard_woo_shops_pkey";
--> statement-breakpoint
ALTER TABLE "dashboard_woo_shops" RENAME CONSTRAINT "cabinet_woo_shops_account_id_cabinet_accounts_id_fk" TO "dashboard_woo_shops_account_id_dashboard_accounts_id_fk";
--> statement-breakpoint
ALTER INDEX "cabinet_credentials_account_idx" RENAME TO "dashboard_credentials_account_idx";
--> statement-breakpoint
ALTER INDEX "cabinet_link_sends_address_idx" RENAME TO "dashboard_link_sends_address_idx";
--> statement-breakpoint
ALTER INDEX "cabinet_link_sends_expires_idx" RENAME TO "dashboard_link_sends_expires_idx";
--> statement-breakpoint
ALTER INDEX "cabinet_sessions_account_idx" RENAME TO "dashboard_sessions_account_idx";
--> statement-breakpoint
ALTER INDEX "cabinet_sessions_expires_idx" RENAME TO "dashboard_sessions_expires_idx";
--> statement-breakpoint
ALTER INDEX "cabinet_verifications_identifier_idx" RENAME TO "dashboard_verifications_identifier_idx";
--> statement-breakpoint
ALTER INDEX "cabinet_woo_grants_expires_idx" RENAME TO "dashboard_woo_grants_expires_idx";
--> statement-breakpoint
ALTER INDEX "cabinet_woo_orders_account_idx" RENAME TO "dashboard_woo_orders_account_idx";
--> statement-breakpoint
ALTER INDEX "cabinet_woo_quotes_account_idx" RENAME TO "dashboard_woo_quotes_account_idx";
--> statement-breakpoint
ALTER TABLE "dashboard_link_sends" DROP CONSTRAINT "cabinet_link_sends_purpose";
--> statement-breakpoint
DELETE FROM "dashboard_link_sends";
--> statement-breakpoint
ALTER TABLE "dashboard_link_sends" ADD CONSTRAINT "dashboard_link_sends_purpose" CHECK ("dashboard_link_sends"."purpose" in ('dashboard', 'report'));
