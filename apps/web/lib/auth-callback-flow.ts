import { authFinalizeResponseSchema } from "@agentify/scanner-contracts";

type CallbackAuthClient = Readonly<{
  auth: Readonly<{
    getSession: () => Promise<{
      data: { session: { access_token: string } | null };
      error: unknown;
    }>;
    signOut: (options: { scope: "local" }) => Promise<unknown>;
  }>;
}>;

export async function finalizeAuthCallbackSession(input: {
  callbackState: string;
  client: CallbackAuthClient;
  fetcher?: typeof fetch;
}) {
  try {
    const { data, error } = await input.client.auth.getSession();
    if (error || !data.session?.access_token)
      throw new Error("supabase_session_missing");
    const response = await (input.fetcher ?? fetch)("/api/v2/auth/finalize", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state: input.callbackState }),
    });
    const parsed = authFinalizeResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!response.ok || !parsed.success)
      throw new Error("registration_finalize_failed");
    return parsed.data.report_url;
  } finally {
    await input.client.auth.signOut({ scope: "local" }).catch(() => undefined);
  }
}
