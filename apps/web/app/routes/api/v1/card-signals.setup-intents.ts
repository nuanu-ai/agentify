import { uuidV7Schema } from "@agentify/scanner-contracts";
import { z } from "zod";

import { visitorOf } from "../../../../lib/server/auth";
import {
  errorResponse,
  hasSameOrigin,
  pageNotMatched,
  visitorUnknownResponse,
} from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { setupCardSignal } from "../../../../lib/server/stripe-card-signal";

const setupRequest = z
  .object({
    scan_id: uuidV7Schema,
    card_signal_consent: z.literal(true),
    // Optional here only so that a press naming no address is refused below
    // in the same words as one naming another.
    signed_in_as: z.string().optional(),
  })
  .strict();

async function setUp(request: Request): Promise<Response> {
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
  const sent = await request.json().catch(() => null);
  const parsed = setupRequest.safeParse(sent);
  if (!parsed.success)
    return errorResponse(
      request,
      400,
      "invalid_card_signal_request",
      "Explicit card-signal consent and a valid scan are required.",
    );
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  // The report page names the address it was loaded for: the session can
  // change in another tab, and the consent and the card would otherwise be
  // recorded under a person who never saw the box.
  if (visitor.kind === "person") {
    const unmatched = pageNotMatched(request, sent, visitor.email);
    if (unmatched !== null) return unmatched;
  }
  try {
    const result = await setupCardSignal({
      visitor,
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
    return Response.json(
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

export const loader = methods({ POST: setUp });
export const action = loader;
