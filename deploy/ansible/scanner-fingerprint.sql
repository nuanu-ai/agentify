-- Run against source and target with the same PostgreSQL major version.
-- One row per application table; count plus an order-independent hash sum.
-- The output contains no table values. Keep it protected because table names
-- and cardinalities are operational information.
SELECT format(
  'SELECT %L, %L, count(*), coalesce(sum((''x'' || substr(md5(to_jsonb(t)::text), 1, 16))::bit(64)::bigint::numeric), 0) FROM %I.%I t;',
  n.nspname, c.relname, n.nspname, c.relname
)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('public', 'pgboss', 'drizzle', 'metabase')
  AND c.relkind IN ('r', 'p')
  AND NOT c.relispartition
ORDER BY n.nspname, c.relname
\gexec
