import { beforeEach, describe, expect, it } from "vitest";

import {
  clearReportCabinetHandoff,
  rememberReportCabinetHandoff,
  takeReportCabinetHandoff,
} from "./report-cabinet-handoff";

const report = "/report/018f5e6f-7a5d-7c0b-8f58-a6b2fe16ca01";
const action =
  "https://agentify.example/cabinet/sign-in/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

beforeEach(clearReportCabinetHandoff);

describe("one-shot report cabinet handoff", () => {
  it("destructively takes one exact-report action", () => {
    expect(
      rememberReportCabinetHandoff(report, action, "https://agentify.example"),
    ).toBe(true);
    expect(takeReportCabinetHandoff(`${report.slice(0, -1)}2`)).toBeUndefined();
    expect(takeReportCabinetHandoff(report)).toBeUndefined();

    expect(
      rememberReportCabinetHandoff(report, action, "https://agentify.example"),
    ).toBe(true);
    expect(takeReportCabinetHandoff(report)).toEqual({
      action: "/cabinet/sign-in/open",
      token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(takeReportCabinetHandoff(report)).toBeUndefined();
  });

  it("keeps the raw handoff out of the value rendered as a navigation target", () => {
    expect(
      rememberReportCabinetHandoff(report, action, "https://agentify.example"),
    ).toBe(true);

    const taken = takeReportCabinetHandoff(report);
    expect(taken?.action).toBe("/cabinet/sign-in/open");
    expect(taken?.action).not.toContain("token");
    expect(taken?.token).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it.each([
    "https://evil.example/cabinet/sign-in/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "https://agentify.example/cabinet/sign-in/open?token=short",
    "https://agentify.example/cabinet/sign-in/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&next=/",
    "https://agentify.example/cabinet/sign-in/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA#kept",
    "https://user@agentify.example/cabinet/sign-in/open?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "https://agentify.example/cabinet/cards?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ])(
    "refuses an action outside the closed cabinet landing shape: %s",
    (url) => {
      expect(
        rememberReportCabinetHandoff(report, url, "https://agentify.example"),
      ).toBe(false);
      expect(takeReportCabinetHandoff(report)).toBeUndefined();
    },
  );
});
