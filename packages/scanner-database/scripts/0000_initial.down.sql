-- DESTRUCTIVE: local migration verification only. Never execute against shared or production data.
DROP TABLE IF EXISTS
  merchant_applications,
  browser_observation_findings,
  browser_observation_budget_days,
  browser_observations,
  delivery_outbox,
  analytics_events,
  payment_signals,
  scan_shares,
  waitlist_entries,
  report_sessions,
  scanner_auth_accounts,
  scanner_auth_sessions,
  scanner_auth_verifications,
  verification_tokens,
  registration_intents,
  lead_scans,
  scan_fingerprints,
  scan_checks,
  scan_snapshots,
  scans,
  leads,
  scanner_auth_users,
  consent_snapshots,
  sessions,
  rate_limit_events,
  rate_windows,
  webhook_receipts,
  worker_heartbeats
CASCADE;

DROP TYPE IF EXISTS webhook_receipt_status;
DROP TYPE IF EXISTS browser_observation_status;
DROP TYPE IF EXISTS share_status;
DROP TYPE IF EXISTS segment;
DROP TYPE IF EXISTS scan_status;
DROP TYPE IF EXISTS payment_signal_status;
DROP TYPE IF EXISTS outbox_status;
DROP TYPE IF EXISTS diagnostic_level;
DROP TYPE IF EXISTS delivery_destination;
DROP TYPE IF EXISTS check_status;
DROP SCHEMA IF EXISTS drizzle CASCADE;
