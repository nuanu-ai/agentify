-- The accepted target identity projection must survive the later scanner
-- cleanup. Hash the complete target rows before and after that step; no
-- addresses, token claims or merchant keys leave PostgreSQL in this output.
SELECT format(
  'SELECT %L AS relation, count(*) AS rows, encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text, ''UTF8'')), ''hex''), '''' ORDER BY t.id), ''''), ''UTF8'')), ''hex'') AS digest FROM public.%I t;',
  c.relname, c.relname
)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
AND c.relname IN ('cabinet_accounts', 'cabinet_verifications', 'scanner_recovery_intents')
ORDER BY c.relname
\gexec
