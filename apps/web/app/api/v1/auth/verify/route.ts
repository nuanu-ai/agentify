import { type NextRequest, NextResponse } from "next/server";

import { REPORT_SESSION_COOKIE } from "../../../../../lib/server/auth";
import { getServerConfig } from "../../../../../lib/server/config";
import { verifyEmailToken } from "../../../../../lib/server/registration";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const config = getServerConfig();
  if (!token || token.length < 32)
    return NextResponse.redirect(
      new URL("/verification/error", config.appBaseUrl),
      303,
    );
  const result = await verifyEmailToken(token);
  if (result.status !== "verified") {
    const target = result.scanId
      ? `/scan/${encodeURIComponent(result.scanId)}?verification=expired_or_used`
      : "/verification/error";
    return NextResponse.redirect(new URL(target, config.appBaseUrl), 303);
  }
  const response = NextResponse.redirect(
    new URL(`/report/${result.scanId}`, config.appBaseUrl),
    303,
  );
  response.cookies.set(REPORT_SESSION_COOKIE, result.sessionToken, {
    httpOnly: true,
    secure: config.production,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 86_400,
  });
  return response;
}
