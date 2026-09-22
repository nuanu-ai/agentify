import { type NextRequest, NextResponse } from "next/server";

import { REPORT_SESSION_COOKIE } from "../../../../../../lib/server/auth";
import { errorResponse, hasSameOrigin } from "../../../../../../lib/server/http";
import { confirmLocalCardSignal } from "../../../../../../lib/server/stripe-card-signal";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ signalId: string }> },
) {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const { signalId } = await params;
  try {
    const result = await confirmLocalCardSignal({
      signalId,
      sessionToken: request.cookies.get(REPORT_SESSION_COOKIE)?.value,
    });
    if (!result)
      return errorResponse(request, 404, "card_signal_not_found", "The card signal was not found.");
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return errorResponse(
      request,
      404,
      "local_card_confirmation_unavailable",
      "Local card confirmation is unavailable in this environment.",
    );
  }
}
