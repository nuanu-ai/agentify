import {
  createScanRequestSchema,
  scanUrlWasSubmittedWithoutScheme,
} from "@agentify/scanner-contracts";
import { type NextRequest, NextResponse } from "next/server";

import { getServerConfig } from "../../../../lib/server/config";
import { hmacHex } from "../../../../lib/server/crypto";
import { errorResponse, hasSameOrigin } from "../../../../lib/server/http";
import { consumeScanRateLimits } from "../../../../lib/server/rate-limit";
import {
  ANONYMOUS_COOKIE,
  createOrReplayScan,
  lookupScanReplay,
} from "../../../../lib/server/scans";
import { verifyTurnstileToken } from "../../../../lib/server/turnstile";

export const runtime = "nodejs";

async function verifyTurnstile(
  token: string | null,
  remoteIp: string,
): Promise<boolean> {
  const config = getServerConfig();
  if (!config.TURNSTILE_ENFORCED) return true;
  if (!token || !config.TURNSTILE_SECRET_KEY) return false;
  return verifyTurnstileToken({
    token,
    remoteIp,
    secret: config.TURNSTILE_SECRET_KEY,
    expectedHostname: new URL(config.appBaseUrl).hostname,
    action: "scan",
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
  const config = getServerConfig();
  if (!config.SCAN_ACCEPTANCE_ENABLED) {
    return errorResponse(
      request,
      503,
      "temporarily_busy",
      "New scans are temporarily paused. Existing private reports remain available.",
      true,
      60,
    );
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (
    !idempotencyKey ||
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 200
  ) {
    return errorResponse(
      request,
      400,
      "invalid_idempotency_key",
      "A valid Idempotency-Key header is required.",
    );
  }
  const rawBody: unknown = await request.json().catch(() => null);
  const parsed = createScanRequestSchema.safeParse(rawBody);
  if (!parsed.success)
    return errorResponse(
      request,
      400,
      "invalid_url",
      "Provide a valid public HTTP(S) URL.",
    );

  const anonymousToken = request.cookies.get(ANONYMOUS_COOKIE)?.value;
  const submittedWithoutScheme = scanUrlWasSubmittedWithoutScheme(
    rawBody && typeof rawBody === "object" && "url" in rawBody
      ? rawBody.url
      : undefined,
  );
  try {
    const replay = await lookupScanReplay(
      parsed.data,
      idempotencyKey,
      anonymousToken,
      submittedWithoutScheme,
    );
    if (replay?.conflict)
      return errorResponse(
        request,
        409,
        "idempotency_conflict",
        "This key was already used for another request.",
      );
    if (replay) {
      if (replay.status === "accepted") {
        try {
          await createOrReplayScan(
            parsed.data,
            idempotencyKey,
            anonymousToken,
            submittedWithoutScheme,
          );
        } catch {
          return errorResponse(
            request,
            503,
            "temporarily_busy",
            "The scanner queue is temporarily unavailable.",
            true,
            30,
          );
        }
      }
      return NextResponse.json(
        {
          scan_id: replay.scanId,
          access_token: replay.accessToken,
          status: "accepted",
          status_url: `/api/v1/scans/${replay.scanId}/status`,
          estimated_seconds: 60,
        },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch {
    return errorResponse(
      request,
      400,
      "invalid_url",
      "The URL contains a blocked host, port, or sensitive query key.",
    );
  }

  const remoteIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ipKey = hmacHex(config.hmacSecret, "rate-ip", remoteIp);
  let targetHost: string;
  try {
    const { canonicalizeTarget } = await import("@agentify/scanner");
    targetHost = canonicalizeTarget(parsed.data.url).hostname;
  } catch {
    return errorResponse(
      request,
      400,
      "invalid_url",
      "The URL contains a blocked host, port, or sensitive query key.",
    );
  }
  const targetKey = hmacHex(config.hmacSecret, "rate-target", targetHost);
  const challengePassed = await verifyTurnstile(
    parsed.data.turnstile_token,
    remoteIp,
  );
  const rateResult = await consumeScanRateLimits({
    ipKey,
    targetKey,
    challengePassed,
  });
  if (rateResult === "challenge_required") {
    return errorResponse(
      request,
      429,
      "challenge_required",
      "Complete the challenge to continue.",
      true,
      60,
    );
  }
  if (rateResult === "hard_rate_limit") {
    return errorResponse(
      request,
      429,
      "hard_rate_limit",
      "The scan limit has been reached.",
      true,
      3600,
    );
  }

  try {
    const result = await createOrReplayScan(
      parsed.data,
      idempotencyKey,
      anonymousToken,
      submittedWithoutScheme,
    );
    if (result.conflict)
      return errorResponse(
        request,
        409,
        "idempotency_conflict",
        "This key was already used for another request.",
      );
    const response = NextResponse.json(
      {
        scan_id: result.scanId,
        access_token: result.accessToken,
        status: "accepted",
        status_url: `/api/v1/scans/${result.scanId}/status`,
        estimated_seconds: 60,
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
    if (result.anonymousToken) {
      response.cookies.set(ANONYMOUS_COOKIE, result.anonymousToken, {
        httpOnly: true,
        secure: config.production,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 86_400,
      });
    }
    return response;
  } catch {
    return errorResponse(
      request,
      503,
      "temporarily_busy",
      "The scanner queue is temporarily unavailable.",
      true,
      30,
    );
  }
}
