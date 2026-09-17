-- Counts and order-independent row fingerprints of retained customer records.
-- Queue runtime, worker heartbeat and expiry bookkeeping are intentionally
-- excluded. The output contains no row values, credentials or customer IDs.
-- Live approval is new operator metadata. Exclude only that key so adding its
-- nullable column preserves the fingerprint of every pre-existing merchant
-- field. The reviewed approval set is reconciled separately before activation.
SELECT format(
  'SELECT %L, count(*), coalesce(sum((''x'' || substr(md5((%s)::text), 1, 16))::bit(64)::bigint::numeric), 0) FROM public.%I t;',
  c.relname,
  CASE WHEN c.relname = 'merchants' THEN 'to_jsonb(t) - ''live_approved_at''' ELSE 'to_jsonb(t)' END,
  c.relname
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

-- Preserve approval metadata independently on ordinary releases. A missing
-- pre-migration column and its new NULL default have the same JSON value.
-- The first reviewed grant happens after this migration comparison, while
-- writers remain stopped, and its complete ID set is then checked separately.
SELECT format(
  'SELECT ''merchant_live_approvals'', count(*), coalesce(sum((''x'' || substr(md5(jsonb_build_array(t.id, to_jsonb(t)->''live_approved_at'')::text), 1, 16))::bit(64)::bigint::numeric), 0) FROM public.%I t;',
  c.relname
)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'merchants'
AND c.relkind IN ('r','p') AND NOT c.relispartition
\gexec
