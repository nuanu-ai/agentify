-- Whether a person opted out of product analytics. Nobody has until they
-- choose it in the cabinet's settings.
ALTER TABLE "dashboard_accounts" ADD COLUMN "analytics_opt_out" boolean DEFAULT false NOT NULL;