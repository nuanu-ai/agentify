-- Counts and order-independent row fingerprints of retained customer records.
-- Queue runtime, worker heartbeat and expiry bookkeeping are intentionally
-- excluded. The output contains no row values, credentials or customer IDs.
-- Woo revision is absent before the cabinet's migration 0009 and exactly
-- "legacy" afterwards; only that migration-produced value is normalized. A
-- real grant revision remains part of the protected row.
SELECT format(
  'SELECT %L, count(*), coalesce(sum((''x'' || substr(md5((%s)::text), 1, 16))::bit(64)::bigint::numeric), 0) FROM public.%I t;',
  c.relname,
  CASE WHEN c.relname = 'cabinet_woo_shops' THEN 'CASE WHEN to_jsonb(t)->>''revision'' = ''legacy'' THEN to_jsonb(t) - ''revision'' ELSE to_jsonb(t) END'
       ELSE 'to_jsonb(t)' END,
  c.relname
)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
AND c.relname IN (
  'merchants','merchant_keys','cards','orders','receipts',
  'cabinet_accounts','cabinet_credentials','cabinet_woo_shops','cabinet_woo_orders',
  'leads','lead_scans','registration_intents','report_sessions','scan_shares'
)
ORDER BY c.relname
\gexec
