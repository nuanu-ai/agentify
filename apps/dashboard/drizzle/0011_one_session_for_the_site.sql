-- One session for the whole site (ADR-0026 §2). The scanner no longer consumes
-- a token and asks for a receipt; every link lands on the cabinet's page, and
-- the session a scanner-asked link opens records the request it was asked for.
DROP TABLE "cabinet_report_receipts" CASCADE;--> statement-breakpoint
ALTER TABLE "cabinet_sessions" ADD COLUMN "report_request" text;
