-- A protected, minimal identity inventory. No password hash, session, token,
-- raw_user_meta_data or encrypted lead field is exported.
SELECT json_build_object(
  'id', u.id::text,
  'email', u.email,
  'confirmed', u.email_confirmed_at IS NOT NULL,
  'linked_leads', (SELECT count(*) FROM public.leads l WHERE l.supabase_user_id = u.id)
)::text
FROM auth.users u
ORDER BY u.id;
