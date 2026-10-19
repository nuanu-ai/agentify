-- A registration an ad brought is reported without anything asked on the
-- sign-in pages, so a report holds no consent: the moment a box was ticked and
-- the version of its sentence are dropped. Every row keeps its click id while
-- pending, its state and its dates, and a pending report is still delivered.
--
-- One way: a database migrated by this has no consent records to give back.
ALTER TABLE "dashboard_registration_postbacks" DROP COLUMN "consented_at";--> statement-breakpoint
ALTER TABLE "dashboard_registration_postbacks" DROP COLUMN "consent_wording";