import { describe, expect, it, vi } from "vitest";

import { finalizeAuthCallbackSession } from "./auth-callback-flow";

function clientWithSession(accessToken: string | undefined) {
  const signOut = vi.fn(async () => undefined);
  return {
    client: {
      auth: {
        getSession: vi.fn(async () => ({
          data: {
            session: accessToken ? { access_token: accessToken } : null,
          },
          error: null,
        })),
        signOut,
      },
    },
    signOut,
  };
}

describe("finalizeAuthCallbackSession", () => {
  it("clears the local Supabase JWT after a successful callback", async () => {
    const { client, signOut } = clientWithSession("access-token");
    await expect(
      finalizeAuthCallbackSession({
        callbackState: "state",
        client,
        fetcher: vi.fn(async () =>
          Response.json({ status: "verified", report_url: "/report/id" }),
        ),
      }),
    ).resolves.toBe("/report/id");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("clears the local Supabase JWT after a rejected callback", async () => {
    const { client, signOut } = clientWithSession("access-token");
    await expect(
      finalizeAuthCallbackSession({
        callbackState: "state",
        client,
        fetcher: vi.fn(async () =>
          Response.json({ code: "verification_invalid" }, { status: 401 }),
        ),
      }),
    ).rejects.toThrow("registration_finalize_failed");
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
