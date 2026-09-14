"use client";

import { createClient } from "@supabase/supabase-js";

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_AUTH_PUBLISHABLE_KEY;
  if (!url || !publishableKey) throw new Error("supabase_auth_unavailable");
  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: true,
      flowType: "implicit",
      persistSession: true,
    },
  });
}
