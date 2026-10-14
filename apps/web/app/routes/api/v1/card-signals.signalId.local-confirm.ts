import type { Params } from "react-router";
import { visitorOf } from "../../../../lib/server/auth";
import { errorResponse, hasSameOrigin, visitorUnknownResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { confirmLocalCardSignal } from "../../../../lib/server/stripe-card-signal";

async function confirmLocally(request: Request, params: Params): Promise<Response> {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  try {
    const result = await confirmLocalCardSignal({
      signalId: params.signalId ?? "",
      visitor,
    });
    if (!result)
      return errorResponse(request, 404, "card_signal_not_found", "The card signal was not found.");
    return Response.json(result, {
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

export const loader = methods({ POST: confirmLocally });
export const action = loader;
