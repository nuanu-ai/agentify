import { describe, expect, it } from "vitest";

import { sessionLookupResult } from "./auth-callback";

describe("report callback session lookup", () => {
  it("keeps a fresh valid link behind explicit confirmation when no session matches", () => {
    expect(
      sessionLookupResult({ status: "recovery_requested" }, "ready"),
    ).toEqual({
      state: "ready",
    });
  });

  it("keeps the ordinary recovery form for a recovery-only visit", () => {
    expect(sessionLookupResult(null, "recovery")).toEqual({
      state: "recovery",
    });
  });

  it("accepts only one exact local report path from a matching session", () => {
    const report = "/report/018f5e6f-7a5d-7c0b-8f58-a6b2fe16ca01";
    expect(sessionLookupResult({ report_url: report }, "ready")).toEqual({
      reportUrl: report,
    });
    for (const report_url of [
      "https://evil.example/report/018f5e6f-7a5d-7c0b-8f58-a6b2fe16ca01",
      "/report/../cabinet/cards",
      "/report/not-a-scan",
    ]) {
      expect(sessionLookupResult({ report_url }, "ready")).toEqual({
        state: "ready",
      });
    }
  });
});
