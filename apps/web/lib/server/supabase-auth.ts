import { createClient } from "@supabase/supabase-js";

import { getServerConfig } from "./config";

export function isStaleAgentifyAuthUser(
  user: Readonly<{
    confirmed_at?: string;
    created_at: string;
    email_confirmed_at?: string;
    user_metadata: Record<string, unknown>;
  }>,
  cutoff: Date,
) {
  return (
    user.user_metadata.agentify_registration === true &&
    !user.email_confirmed_at &&
    !user.confirmed_at &&
    new Date(user.created_at).getTime() < cutoff.getTime()
  );
}

function createSupabaseAuthClient() {
  const config = getServerConfig();
  if (!config.supabaseAuthUrl || !config.supabaseAuthPublishableKey) {
    throw new Error("supabase_auth_unavailable");
  }
  return createClient(
    config.supabaseAuthUrl,
    config.supabaseAuthPublishableKey,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );
}

function createSupabaseAuthAdminClient() {
  const config = getServerConfig();
  if (!config.supabaseAuthUrl || !config.SUPABASE_AUTH_SERVICE_ROLE_KEY) {
    throw new Error("supabase_auth_admin_unavailable");
  }
  return createClient(
    config.supabaseAuthUrl,
    config.SUPABASE_AUTH_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    },
  );
}

export async function sendSupabaseMagicLink(
  email: string,
  emailRedirectTo: string,
): Promise<void> {
  const { error } = await createSupabaseAuthClient().auth.signInWithOtp({
    email,
    options: {
      data: { agentify_registration: true },
      emailRedirectTo,
      shouldCreateUser: true,
    },
  });
  if (error) throw new Error("supabase_auth_email_unavailable");
}

export async function getSupabaseUser(
  accessToken: string,
): Promise<Readonly<{ id: string; email: string }> | undefined> {
  const { data, error } =
    await createSupabaseAuthClient().auth.getUser(accessToken);
  if (error || !data.user?.email || !data.user.email_confirmed_at)
    return undefined;
  return { id: data.user.id, email: data.user.email };
}

export type SupabaseAuthAdminProvider = Readonly<{
  deleteUser: (userId: string) => Promise<void>;
  deleteUserIfStillStale: (userId: string, cutoff: Date) => Promise<boolean>;
  listStaleUnconfirmedUserIds: (
    cutoff: Date,
    limit: number,
  ) => Promise<readonly string[]>;
}>;

export function getSupabaseAuthAdminProvider():
  SupabaseAuthAdminProvider | undefined {
  const config = getServerConfig();
  if (!config.supabaseAuthUrl || !config.SUPABASE_AUTH_SERVICE_ROLE_KEY) {
    return undefined;
  }
  const client = createSupabaseAuthAdminClient();
  async function getUserById(userId: string) {
    const lookup = await client.auth.admin.getUserById(userId);
    if (lookup.error) {
      if (lookup.error.status === 404) return undefined;
      throw new Error("supabase_auth_lookup_unavailable");
    }
    return lookup.data.user ?? undefined;
  }
  return {
    async listStaleUnconfirmedUserIds(cutoff, limit) {
      const userIds: string[] = [];
      let page = 1;
      const perPage = Math.min(1_000, Math.max(50, limit));
      while (userIds.length < limit) {
        const listed = await client.auth.admin.listUsers({ page, perPage });
        if (listed.error) throw new Error("supabase_auth_list_unavailable");
        for (const user of listed.data.users) {
          if (isStaleAgentifyAuthUser(user, cutoff)) {
            userIds.push(user.id);
            if (userIds.length >= limit) break;
          }
        }
        if (!listed.data.nextPage || page >= listed.data.lastPage) break;
        page = listed.data.nextPage;
      }
      return userIds;
    },
    async deleteUserIfStillStale(userId, cutoff) {
      const user = await getUserById(userId);
      if (!user || !isStaleAgentifyAuthUser(user, cutoff)) return false;
      const removed = await client.auth.admin.deleteUser(userId);
      if (removed.error) {
        if (removed.error.status === 404) return false;
        throw new Error("supabase_auth_delete_unavailable");
      }
      return true;
    },
    async deleteUser(userId: string) {
      const user = await getUserById(userId);
      if (!user) return;
      const removed = await client.auth.admin.deleteUser(userId);
      if (removed.error && removed.error.status !== 404) {
        throw new Error("supabase_auth_delete_unavailable");
      }
    },
  };
}
