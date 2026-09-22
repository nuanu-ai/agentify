import { describe, expect, it } from "vitest";

import { linkAnswerFailure, waitLabel } from "./link-answer";

const envelope = (error: Record<string, unknown>) => ({ error });

describe("what the browser does with a refused link request", () => {
  it("takes the wait and the words from the server instead of inventing either", () => {
    const failure = linkAnswerFailure(
      envelope({
        code: "verification_link_cooldown",
        message: "No new link was sent. You can ask for another in 40 seconds.",
        retryable: true,
        retry_after_seconds: 40,
        request_id: "019f5b6a-4b9f-7000-8000-000000000001",
      }),
    );

    expect(failure.waitSeconds).toBe(40);
    expect(failure.message).toContain("40 seconds");
  });

  it("leaves the button usable when the answer carries no wait", () => {
    const failure = linkAnswerFailure(
      envelope({
        code: "verification_link_cooldown",
        message: "No new link was sent, and we cannot tell how long the wait is.",
        retryable: true,
        request_id: "019f5b6a-4b9f-7000-8000-000000000001",
      }),
    );

    expect(failure.waitSeconds).toBe(0);
    expect(failure.message).toContain("cannot tell");
  });

  it("falls back to its own words only when the answer is not one we can read", () => {
    for (const payload of [null, "gateway timeout", { error: { code: "x" } }]) {
      const failure = linkAnswerFailure(payload);
      expect(failure.waitSeconds).toBe(0);
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });

  it("counts a wait down in the unit a person reads at a glance", () => {
    expect(waitLabel(40)).toBe("40s");
    expect(waitLabel(59)).toBe("59s");
    expect(waitLabel(60)).toBe("1m");
    expect(waitLabel(510)).toBe("9m");
  });
});
