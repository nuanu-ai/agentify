import { type NextRequest, NextResponse } from "next/server";

import { visitorOf } from "../../../../../lib/server/auth";
import { errorResponse, visitorUnknownResponse } from "../../../../../lib/server/http";
import { getCardSignalState } from "../../../../../lib/server/stripe-card-signal";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ signalId: string }> },
) {
  const { signalId } = await params;
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  const signal = await getCardSignalState(signalId, visitor);
  if (!signal)
    return errorResponse(request, 404, "card_signal_not_found", "The card signal was not found.");
  return NextResponse.json(signal, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
