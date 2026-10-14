import type { Params } from "react-router";
import { visitorOf } from "../../../../lib/server/auth";
import { errorResponse, visitorUnknownResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { getCardSignalState } from "../../../../lib/server/stripe-card-signal";

async function signalState(request: Request, params: Params): Promise<Response> {
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  const signal = await getCardSignalState(params.signalId ?? "", visitor);
  if (!signal)
    return errorResponse(request, 404, "card_signal_not_found", "The card signal was not found.");
  return Response.json(signal, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export const loader = methods({ GET: signalState });
export const action = loader;
