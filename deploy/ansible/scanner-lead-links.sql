SELECT json_build_object('id', id::text, 'supabase_user_id', supabase_user_id::text)::text
FROM public.leads ORDER BY id;
