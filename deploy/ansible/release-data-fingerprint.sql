-- Counts and order-independent row fingerprints of retained customer records.
-- Queue runtime, worker heartbeat and expiry bookkeeping are intentionally
-- excluded. The output contains no row values, credentials or customer IDs.
SELECT format(
  'SELECT %L, count(*), coalesce(sum((''x'' || substr(md5(to_jsonb(t)::text), 1, 16))::bit(64)::bigint::numeric), 0) FROM public.%I t;',
  c.relname, c.relname
)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
AND c.relname IN (
  'merchants','merchant_keys','cards','orders','receipts',
  'cabinet_accounts','cabinet_credentials','cabinet_woo_shops','cabinet_woo_orders',
  'scanner_auth_users','scanner_auth_accounts','leads','lead_scans',
  'registration_intents','verification_tokens','report_sessions','scan_shares'
)
ORDER BY c.relname
\gexec
