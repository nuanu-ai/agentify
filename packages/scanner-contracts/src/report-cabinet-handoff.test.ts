import { describe, expect, it } from "vitest";

import {
  openReportCabinetHandoff,
  REPORT_CABINET_HANDOFF_COOKIE,
  REPORT_CABINET_HANDOFF_TTL_SECONDS,
  sealReportCabinetHandoff,
} from "./report-cabinet-handoff";

const secret = "shared-report-identity-secret-with-32-bytes";
const now = new Date("2026-09-21T08:00:00.000Z");
const email = "owner@example.com";
const scanId = "018f5e6f-7a5d-7c0b-8f58-a6b2fe16ca01";
const reportPath = `/report/${scanId}`;
const token = "A".repeat(32);
const actionUrl = `https://agentify.example/cabinet/sign-in/open?token=${token}`;

describe("report-to-cabinet handoff envelope", () => {
  it("binds one cabinet token to the normalized owner and exact report for one hour", () => {
    const sealed = sealReportCabinetHandoff({
      actionUrl,
      email: " OWNER@Example.com ",
      now,
      publicOrigin: "https://agentify.example",
      scanId,
      secret,
    });
    if (!sealed) throw new Error("sealing a valid handoff produced nothing");

    expect(REPORT_CABINET_HANDOFF_COOKIE).toBe("agentify_report_cabinet_handoff");
    expect(REPORT_CABINET_HANDOFF_TTL_SECONDS).toBe(3600);
    expect(sealed).not.toContain(token);
    expect(
      openReportCabinetHandoff(sealed, {
        email,
        now: new Date(now.getTime() + 3_599_000),
        reportPath,
        secret,
      }),
    ).toEqual({ email, reportPath, scanId, token });
  });

  it("fails closed for tampering, another owner or report, expiry and future issuance", () => {
    const sealed = sealReportCabinetHandoff({
      actionUrl,
      email,
      now,
      publicOrigin: "https://agentify.example",
      scanId,
      secret,
    });
    if (!sealed) throw new Error("sealing a valid handoff produced nothing");
    const signatureStart = sealed.lastIndexOf(".") + 1;
    const changed = `${sealed.slice(0, signatureStart)}${sealed[signatureStart] === "A" ? "B" : "A"}${sealed.slice(signatureStart + 1)}`;

    for (const [value, expectedEmail, expectedPath, at] of [
      [changed, email, reportPath, now],
      [sealed, "other@example.com", reportPath, now],
      [sealed, email, `/report/${scanId.slice(0, -1)}2`, now],
      [sealed, email, reportPath, new Date(now.getTime() + 3_600_000)],
      [sealed, email, reportPath, new Date(now.getTime() - 61_000)],
    ] as const) {
      expect(
        openReportCabinetHandoff(value, {
          email: expectedEmail,
          now: at,
          reportPath: expectedPath,
          secret,
        }),
      ).toBeNull();
    }
  });

  it("rejects an oversized envelope before parsing it", () => {
    expect(
      openReportCabinetHandoff("x".repeat(2_049), {
        email,
        now,
        reportPath,
        secret,
      }),
    ).toBeNull();
  });

  it.each([
    `https://evil.example/cabinet/sign-in/open?token=${token}`,
    "https://agentify.example/cabinet/sign-in/open?token=short",
    `${actionUrl}&next=/cabinet/cards`,
    `${actionUrl}#fragment`,
    `https://user@agentify.example/cabinet/sign-in/open?token=${token}`,
    `https://agentify.example/cabinet/cards?token=${token}`,
  ])("refuses a cabinet action outside the closed same-origin shape: %s", (candidate) => {
    expect(
      sealReportCabinetHandoff({
        actionUrl: candidate,
        email,
        now,
        publicOrigin: "https://agentify.example",
        scanId,
        secret,
      }),
    ).toBeNull();
  });
});
