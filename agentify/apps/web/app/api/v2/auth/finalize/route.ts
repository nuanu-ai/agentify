import {
  authFinalizeRequestSchema,
  authFinalizeResponseSchema,
} from "@b2a/contracts";
import { type NextRequest, NextResponse } from "next/server";

import { REPORT_SESSION_COOKIE } from "../../../../../lib/server/auth";
import { getServerConfig } from "../../../../../lib/server/config";
import {
  bearerToken,
  errorResponse,
  hasSameOrigin,
} from "../../../../../lib/server/http";
import { finalizeSupabaseRegistration } from "../../../../../lib/server/supabase-registration";

export const runtime = "nodejs";

export function attachReportSessionCookie(
  response: NextResponse,
  sessionToken: string,
  production: boolean,
) {
  response.cookies.set(REPORT_SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: production,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 86_400,
  });
}

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request))
    return errorResponse(
      request,
      403,
      "invalid_origin",
      "The request origin is not allowed.",
    );
  const accessToken = bearerToken(request);
  const parsed = authFinalizeRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!accessToken || !parsed.success)
    return errorResponse(
      request,
      401,
      "verification_invalid",
      "The verification link is invalid or expired.",
    );
  try {
    const finalized = await finalizeSupabaseRegistration(
      parsed.data.state,
      accessToken,
    );
    if (!finalized)
      return errorResponse(
        request,
        401,
        "verification_invalid",
        "The verification link is invalid or expired.",
      );
    const payload = authFinalizeResponseSchema.parse({
      status: "verified",
      report_url: `/report/${encodeURIComponent(finalized.scanId)}`,
    });
    const response = NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
    const config = getServerConfig();
    attachReportSessionCookie(
      response,
      finalized.sessionToken,
      config.production,
    );
    return response;
  } catch {
    return errorResponse(
      request,
      503,
      "verification_unavailable",
      "Verification is temporarily unavailable.",
      true,
      30,
    );
  }
}
