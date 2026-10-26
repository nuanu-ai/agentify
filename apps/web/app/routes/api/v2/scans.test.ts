/**
 * Asking for a scan's report by email, asked of the whole process over HTTP.
 * Whether the scan's token holds, the report is ready and who is asking are
 * the database's and the dashboard's to say; what is refused before them is
 * here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowedAt, fromSite, refusalOf, stubOfflineScanner } from "../../../../testing/api";
import { ask } from "../../../../testing/scanner";

beforeEach(stubOfflineScanner);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const REGISTRATIONS = "/api/v2/scans/0190f4c5-0000-7000-8000-000000000000/registrations";

const asked = {
  email: "person@example.com",
  role: "owner",
  site_is_mine: true,
  marketing_email_opt_in: false,
  dataset_reuse_acknowledged: true,
};

describe("asking for a scan's report", () => {
  it("is refused when it comes from another origin", async () => {
    vi.stubEnv("REGISTRATION_ENABLED", "true");

    const answered = await fromSite(REGISTRATIONS, "POST", asked, {
      origin: "https://elsewhere.example",
      authorization: "Bearer a-scan-token",
    });

    expect(answered.status).toBe(403);
    expect((await refusalOf(answered)).code).toBe("invalid_origin");
  });

  it("is not offered, and says to come back in an hour, while contact verification is off", async () => {
    const answered = await fromSite(REGISTRATIONS, "POST", asked, {
      authorization: "Bearer a-scan-token",
    });

    expect(answered.status).toBe(503);
    expect(await refusalOf(answered)).toMatchObject({
      code: "registration_unavailable",
      retryable: true,
      retry_after_seconds: 3600,
    });
  });

  it("is private to whoever holds the scan's token", async () => {
    vi.stubEnv("REGISTRATION_ENABLED", "true");

    const answered = await fromSite(REGISTRATIONS, "POST", asked);

    expect(answered.status).toBe(401);
    expect((await refusalOf(answered)).code).toBe("unauthorized");
  });

  it("takes a post alone", async () => {
    expect((await ask(REGISTRATIONS)).status).toBe(405);
    expect(await allowedAt(REGISTRATIONS)).toBe("OPTIONS, POST");
  });

  it.each([
    ["phone", { phone: "415 555 0123" }, "invalid_phone", /phone.*country code/i],
    ["email", { email: "person-at-example.com" }, "invalid_email", /email/i],
    [
      "data notice",
      { dataset_reuse_acknowledged: false },
      "data_notice_unacknowledged",
      /scanner data notice/i,
    ],
  ])(
    "names the %s when that is what it refuses, before the scan is looked up",
    async (_field, changed, code, words) => {
      vi.stubEnv("REGISTRATION_ENABLED", "true");

      const answered = await fromSite(
        REGISTRATIONS,
        "POST",
        { ...asked, ...changed },
        { authorization: "Bearer a-scan-token" },
      );

      expect(answered.status).toBe(400);
      const refusal = await refusalOf(answered);
      expect(refusal.code).toBe(code);
      expect(refusal.message).toMatch(words);
    },
  );

  it("refuses an ask the form could not have sent without naming a field of it", async () => {
    vi.stubEnv("REGISTRATION_ENABLED", "true");

    const answered = await fromSite(
      REGISTRATIONS,
      "POST",
      { ...asked, unexpected: true },
      { authorization: "Bearer a-scan-token" },
    );

    expect(answered.status).toBe(400);
    expect((await refusalOf(answered)).code).toBe("invalid_registration");
  });
});
