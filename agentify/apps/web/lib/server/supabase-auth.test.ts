import { describe, expect, it } from "vitest";

import { isStaleAgentifyAuthUser } from "./supabase-auth";

const cutoff = new Date("2026-07-01T00:00:00.000Z");

describe("Supabase Auth pending-user retention", () => {
  it("selects only old unconfirmed Agentify registrations", () => {
    expect(
      isStaleAgentifyAuthUser(
        {
          created_at: "2026-05-01T00:00:00.000Z",
          user_metadata: { agentify_registration: true },
        },
        cutoff,
      ),
    ).toBe(true);
    expect(
      isStaleAgentifyAuthUser(
        {
          created_at: "2026-05-01T00:00:00.000Z",
          email_confirmed_at: "2026-05-01T00:05:00.000Z",
          user_metadata: { agentify_registration: true },
        },
        cutoff,
      ),
    ).toBe(false);
    expect(
      isStaleAgentifyAuthUser(
        {
          created_at: "2026-05-01T00:00:00.000Z",
          user_metadata: {},
        },
        cutoff,
      ),
    ).toBe(false);
    expect(
      isStaleAgentifyAuthUser(
        {
          created_at: "2026-07-10T00:00:00.000Z",
          user_metadata: { agentify_registration: true },
        },
        cutoff,
      ),
    ).toBe(false);
  });
});
