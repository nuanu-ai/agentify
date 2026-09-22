import {
  openReportCabinetHandoff,
  REPORT_CABINET_HANDOFF_COOKIE,
} from "@agentify/scanner-contracts/report-cabinet-handoff";
import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { REPORT_SESSION_COOKIE } from "../../../../../lib/server/auth";
import {
  attachReportCabinetHandoffCookie,
  attachReportSessionCookie,
} from "./route";

describe("report session cookie", () => {
  it("is HttpOnly, Secure, SameSite=Lax, path-wide and bounded in production", () => {
    const response = NextResponse.json({ ok: true });
    attachReportSessionCookie(response, "opaque-session-token", true);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${REPORT_SESSION_COOKIE}=opaque-session-token`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");
  });
});

describe("fresh report cabinet handoff cookie", () => {
  const scanId = "018f5e6f-7a5d-7c0b-8f58-a6b2fe16ca01";
  const token = "A".repeat(32);
  const secret = "shared-report-identity-secret-with-32-bytes";

  it("is host-only, HttpOnly, Strict, cabinet-scoped and no longer than the link", () => {
    const response = NextResponse.json({ status: "verified" });
    const attached = attachReportCabinetHandoffCookie(response, {
      actionUrl: `https://agentify.example/cabinet/sign-in/open?token=${token}`,
      email: "owner@example.com",
      now: new Date("2026-09-21T08:00:00.000Z"),
      production: true,
      publicOrigin: "https://agentify.example",
      scanId,
      secret,
    });

    expect(attached).toBe(true);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${REPORT_CABINET_HANDOFF_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=strict");
    expect(cookie).toContain("Path=/cabinet");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain(token);

    const value =
      response.cookies.get(REPORT_CABINET_HANDOFF_COOKIE)?.value ?? "";
    expect(
      openReportCabinetHandoff(value, {
        email: "owner@example.com",
        now: new Date("2026-09-21T08:30:00.000Z"),
        reportPath: `/report/${scanId}`,
        secret,
      }),
    ).toMatchObject({ token, scanId });
  });

  it("does not attach authority from an invalid or cross-origin cabinet action", () => {
    for (const actionUrl of [
      `https://evil.example/cabinet/sign-in/open?token=${token}`,
      "https://agentify.example/cabinet/sign-in/open?token=short",
    ]) {
      const response = NextResponse.json({ status: "verified" });
      expect(
        attachReportCabinetHandoffCookie(response, {
          actionUrl,
          email: "owner@example.com",
          now: new Date("2026-09-21T08:00:00.000Z"),
          production: true,
          publicOrigin: "https://agentify.example",
          scanId,
          secret,
        }),
      ).toBe(false);
      expect(
        response.cookies.get(REPORT_CABINET_HANDOFF_COOKIE),
      ).toBeUndefined();
    }
  });
});
