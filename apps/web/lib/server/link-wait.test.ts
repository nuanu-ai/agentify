import { describe, expect, it } from "vitest";

import { type LinkWall, linkCooldownResponse } from "./link-wait";

const request = () =>
  new Request("https://agentify.ad/api/v2/scans/x/registrations", {
    method: "POST",
  });

async function refusal(retryAt: Date, wall: LinkWall, now: Date) {
  const response = linkCooldownResponse(request(), { retryAt, wall }, now);
  const body = (await response.json()) as {
    error: {
      code: string;
      message: string;
      retryable: boolean;
      retry_after_seconds?: number;
    };
  };
  return { response, ...body.error };
}

describe("the wait in front of the next verification link", () => {
  const now = new Date("2026-09-22T10:00:00.000Z");
  const later = (ms: number) => new Date(now.getTime() + ms);

  it("carries the one code the wire contract names, on either door", async () => {
    expect((await refusal(later(40_000), "unspecified", now)).code).toBe(
      "verification_link_cooldown",
    );
    expect((await refusal(later(40_000), "address_hour", now)).code).toBe(
      "verification_link_cooldown",
    );
  });

  it("hands the caller the wait it actually has, in the header and in the words", async () => {
    const answer = await refusal(later(40_000), "unspecified", now);

    expect(answer.response.status).toBe(429);
    expect(answer.retryable).toBe(true);
    expect(answer.retry_after_seconds).toBe(40);
    expect(answer.response.headers.get("Retry-After")).toBe("40");
    expect(answer.message).toContain("40 seconds");
  });

  it("does not dress a sub-minute wait as an hour or as too many requests", async () => {
    const answer = await refusal(later(40_000), "unspecified", now);

    expect(answer.message).not.toMatch(/hour|too many/i);
    expect(answer.message).not.toMatch(/\b3600\b|\b60 minutes\b/);
  });

  it("claims no cause for a wall it cannot see behind", async () => {
    const answer = await refusal(later(40_000), "unspecified", now);

    // The cabinet's answer says when, never which of its two walls refused.
    expect(answer.message).not.toMatch(/because/i);
  });

  it("says the true thing about the one wall it does see", async () => {
    const spent = await refusal(later(12 * 60_000), "address_hour", now);
    const unknown = await refusal(later(12 * 60_000), "unspecified", now);

    expect(spent.message).not.toBe(unknown.message);
    expect(spent.message).toContain("12 minutes");
    expect(spent.message).not.toMatch(/too many/i);
    expect(spent.retry_after_seconds).toBe(720);
  });

  it("rounds a wait up, so nobody is sent back before the wall has gone", async () => {
    expect((await refusal(later(40_200), "unspecified", now)).retry_after_seconds).toBe(41);
    expect((await refusal(later(510_000), "unspecified", now)).retry_after_seconds).toBe(510);
    expect((await refusal(later(510_000), "unspecified", now)).message).toContain("9 minutes");
  });

  it("keeps a wall that has already fallen out of the past tense", async () => {
    const answer = await refusal(later(-5_000), "unspecified", now);

    expect(answer.retry_after_seconds).toBe(1);
    expect(answer.message).toContain("1 second");
  });
});
