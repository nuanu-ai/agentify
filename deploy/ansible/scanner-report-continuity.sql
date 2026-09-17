-- Existing local report ownership and waitlist rows must survive the shared
-- identity migration. The baseline intentionally ends before scanner Auth.
SELECT 'leads', count(*), coalesce(sum(('x' || substr(md5(to_jsonb(l)::text), 1, 16))::bit(64)::bigint::numeric), 0)
FROM public.leads AS l;
SELECT 'lead_scans', count(*), coalesce(sum(('x' || substr(md5(to_jsonb(ls)::text), 1, 16))::bit(64)::bigint::numeric), 0)
FROM public.lead_scans AS ls;
SELECT 'report_sessions', count(*), coalesce(sum(('x' || substr(md5(to_jsonb(r)::text), 1, 16))::bit(64)::bigint::numeric), 0)
FROM public.report_sessions AS r;
SELECT 'waitlist_entries', count(*), coalesce(sum(('x' || substr(md5(to_jsonb(w)::text), 1, 16))::bit(64)::bigint::numeric), 0)
FROM public.waitlist_entries AS w;
