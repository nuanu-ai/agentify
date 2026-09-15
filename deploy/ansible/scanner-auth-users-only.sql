-- Fresh managed Auth identity custody after the DB bridge: current scanner
-- lead links live in the private database, not external public.leads. Export
-- no password, session, token, metadata or stale external lead count.
SELECT json_build_object(
  'id', u.id::text,
  'email', u.email,
  'confirmed', u.email_confirmed_at IS NOT NULL
)::text
FROM auth.users u
ORDER BY u.id;
