-- Existing lead/report rows must survive the additive Auth migration. The new
-- nullable lead link is excluded because it does not exist before migration.
SELECT 'leads', count(*), coalesce(sum(('x' || substr(md5((to_jsonb(l) - 'scanner_auth_user_id')::text), 1, 16))::bit(64)::bigint::numeric), 0)
FROM public.leads AS l;
SELECT 'report_sessions', count(*), coalesce(sum(('x' || substr(md5(to_jsonb(r)::text), 1, 16))::bit(64)::bigint::numeric), 0)
FROM public.report_sessions AS r;
