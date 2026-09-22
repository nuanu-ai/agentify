import { type NextRequest, NextResponse } from "next/server";

import { REPORT_SESSION_COOKIE } from "../../../../../../lib/server/auth";
import { errorResponse, hasSameOrigin } from "../../../../../../lib/server/http";
import { detachCardSignal } from "../../../../../../lib/server/stripe-card-signal";

export const runtime = "nodejs";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ signalId: string }> },
) {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const { signalId } = await params;
  try {
    const result = await detachCardSignal({
      signalId,
      sessionToken: request.cookies.get(REPORT_SESSION_COOKIE)?.value,
    });
    if (!result)
      return errorResponse(request, 404, "card_signal_not_found", "The card signal was not found.");
    if (result.status !== "detached")
      return errorResponse(
        request,
        409,
        "card_signal_not_attached",
        "No attached payment method is available to remove.",
      );
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return errorResponse(
      request,
      502,
      "card_signal_detach_failed",
      "The payment method could not be removed and was not marked detached.",
      true,
    );
  }
}
