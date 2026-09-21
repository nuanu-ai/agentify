-- Existing local report ownership and registration rows must survive the
-- migrations after the restore baseline, which ends before scanner Auth.
-- waitlist_entries is hashed on the columns that must survive, since the
-- survey columns it once carried are dropped by migration 0019 on purpose.
SELECT 'leads', count(*), coalesce(sum(('x' || substr(md5(to_jsonb(l)::text), 1, 16))::bit(64)::bigint::numeric), 0)
FROM public.leads AS l;
SELECT 'lead_scans', count(*), coalesce(sum(('x' || substr(md5(to_jsonb(ls)::text), 1, 16))::bit(64)::bigint::numeric), 0)
FROM public.lead_scans AS ls;
SELECT 'report_sessions', count(*), coalesce(sum(('x' || substr(md5(to_jsonb(r)::text), 1, 16))::bit(64)::bigint::numeric), 0)
FROM public.report_sessions AS r;
SELECT 'waitlist_entries', count(*), coalesce(sum(('x' || substr(md5(jsonb_build_object('id', w.id, 'lead_id', w.lead_id, 'scan_id', w.scan_id, 'created_at', w.created_at)::text), 1, 16))::bit(64)::bigint::numeric), 0)
FROM public.waitlist_entries AS w;
