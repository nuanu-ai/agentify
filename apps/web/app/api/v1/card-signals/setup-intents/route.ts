import { uuidV7Schema } from "@agentify/scanner-contracts";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { REPORT_SESSION_COOKIE } from "../../../../../lib/server/auth";
import { errorResponse, hasSameOrigin } from "../../../../../lib/server/http";
import { setupCardSignal } from "../../../../../lib/server/stripe-card-signal";

export const runtime = "nodejs";

const setupRequest = z
  .object({
    scan_id: uuidV7Schema,
    card_signal_consent: z.literal(true),
  })
  .strict();

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200)
    return errorResponse(
      request,
      400,
      "invalid_idempotency_key",
      "A valid Idempotency-Key header is required.",
    );
  const parsed = setupRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return errorResponse(
      request,
      400,
      "invalid_card_signal_request",
      "Explicit card-signal consent and a valid scan are required.",
    );
  try {
    const result = await setupCardSignal({
      sessionToken: request.cookies.get(REPORT_SESSION_COOKIE)?.value,
      scanId: parsed.data.scan_id,
      idempotencyKey,
    });
    if (result.status === "disabled")
      return errorResponse(
        request,
        503,
        "card_signal_disabled",
        "The optional card signal is not enabled.",
      );
    if (result.status === "unauthorized")
      return errorResponse(request, 404, "report_not_found", "The verified report was not found.");
    return NextResponse.json(
      {
        signal_id: result.signalId,
        status: result.status,
        client_secret: result.clientSecret,
        adapter: result.adapter,
      },
      {
        status: result.status === "setup_pending" ? 201 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return errorResponse(
      request,
      502,
      "card_signal_setup_failed",
      "The card signal could not be prepared. Your report is still available.",
      true,
    );
  }
}
