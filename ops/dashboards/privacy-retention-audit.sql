-- Counts only. Any non-zero overdue count requires privacy-owner review.
select
  (select count(*) from scanner_recovery_intents where coalesce(consumed_at, expires_at) <= now() - interval '7 days') as overdue_recovery_intents,
  (select count(*) from scanner_identity_completions where retain_until <= now()) as overdue_identity_completions,
  (select count(*) from registration_intents where coalesce(consumed_at, expires_at) < now() - interval '7 days') as overdue_registration_intents,
  (select count(*) from leads where verified_at is null and anonymized_at is null and created_at < now() - interval '30 days') as overdue_unverified_leads,
  (select count(*) from report_sessions where expires_at < now() and revoked_at is null) as expired_active_report_sessions,
  (select count(*) from scan_shares where status = 'published') as active_public_shares,
  (select count(*) from payment_signals where status = 'attached') as attached_card_signals,
  (select count(*) from delivery_outbox where status = 'dead_letter') as analytics_dead_letters;
