import { authFinalizeResponseSchema } from "@agentify/scanner-contracts";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { REPORT_SESSION_COOKIE } from "../../../../../lib/server/auth";
import { getServerConfig } from "../../../../../lib/server/config";
import { errorResponse, hasSameOrigin } from "../../../../../lib/server/http";
import { verifyAndFinalizeScannerRegistration } from "../../../../../lib/server/scanner-registration";
import { inspectScannerMagicLinkClaim } from "../../../../../lib/server/scanner-auth";
import { verifyAndFinalizeScannerRecovery } from "../../../../../lib/server/scanner-recovery";

export const runtime = "nodejs";
const verificationRequestSchema = z.object({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  token: z.string().regex(/^[A-Za-z0-9]{32}$/),
});

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
  const parsed = verificationRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return errorResponse(
      request,
      401,
      "verification_invalid",
      "The verification link is invalid or expired.",
    );
  try {
    const claim = await inspectScannerMagicLinkClaim(parsed.data.token);
    const finalized =
      claim?.purpose === "recovery"
        ? await verifyAndFinalizeScannerRecovery(
            parsed.data.state,
            parsed.data.token,
          )
        : await verifyAndFinalizeScannerRegistration(
            parsed.data.state,
            parsed.data.token,
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
