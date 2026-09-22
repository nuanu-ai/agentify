import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { REPORT_SESSION_COOKIE } from "../../../../../lib/server/auth";
import { getServerConfig } from "../../../../../lib/server/config";
import { errorResponse, hasSameOrigin, logServerError } from "../../../../../lib/server/http";
import {
  recoverScannerReportSession,
  requestScannerReportRecovery,
} from "../../../../../lib/server/scanner-recovery";
import { verifyTurnstileToken } from "../../../../../lib/server/turnstile";

export const runtime = "nodejs";

const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const recoveryRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("session"), state: stateSchema.optional() }),
  z.object({
    action: z.literal("email"),
    email: z.email().max(320),
    state: stateSchema.optional(),
    turnstile_token: z.string().min(1).max(4096).nullable(),
  }),
]);

function accepted() {
  return NextResponse.json(
    { status: "recovery_requested" },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}

export async function handleScannerRecoveryRequest(request: NextRequest) {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const body = recoveryRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success)
    return errorResponse(
      request,
      400,
      "recovery_invalid",
      "Check the recovery request and try again.",
    );

  if (body.data.action === "session") {
    try {
      const target = await recoverScannerReportSession(
        request.cookies.get(REPORT_SESSION_COOKIE)?.value,
        body.data.state,
      );
      if (!target) return accepted();
      return NextResponse.json(
        {
          status: "authenticated",
          report_url: `/report/${encodeURIComponent(target.scanId)}`,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    } catch (error) {
      logServerError(request, "scanner_recovery_session_failed", error);
      return accepted();
    }
  }

  // Caddy appends the trusted peer address at the right-hand side.
  const ip = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown";
  const config = getServerConfig();
  if (
    config.TURNSTILE_ENFORCED &&
    (!body.data.turnstile_token ||
      !config.TURNSTILE_SECRET_KEY ||
      !(await verifyTurnstileToken({
        token: body.data.turnstile_token,
        remoteIp: ip,
        secret: config.TURNSTILE_SECRET_KEY,
        expectedHostname: new URL(config.appBaseUrl).hostname,
        action: "report_recovery",
      })))
  ) {
    return errorResponse(
      request,
      403,
      "challenge_required",
      "Complete the privacy-preserving challenge and try again.",
    );
  }
  const { email, state } = body.data;
  try {
    await requestScannerReportRecovery({ email, ip, state });
    return accepted();
  } catch (error) {
    logServerError(request, "scanner_recovery_request_failed", error);
    return errorResponse(
      request,
      503,
      "recovery_unavailable",
      "Recovery email is temporarily unavailable. Try again shortly.",
      true,
      60,
    );
  }
}

export async function POST(request: NextRequest) {
  return await handleScannerRecoveryRequest(request);
}
