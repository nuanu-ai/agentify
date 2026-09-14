import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";

import { REPORT_SESSION_COOKIE } from "../../../../../lib/server/auth";
import { attachReportSessionCookie } from "./route";

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
