import type { Params } from "react-router";
import { visitorOf } from "../../../../lib/server/auth";
import {
  errorResponse,
  hasSameOrigin,
  pageNotMatched,
  visitorUnknownResponse,
} from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { detachCardSignal } from "../../../../lib/server/stripe-card-signal";

async function detach(request: Request, params: Params): Promise<Response> {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  // The report page names the address it was loaded for, so a page left open
  // across a change of session acts for nobody else.
  if (visitor.kind === "person") {
    const unmatched = pageNotMatched(
      request,
      await request.json().catch(() => null),
      visitor.email,
    );
    if (unmatched !== null) return unmatched;
  }
  try {
    const result = await detachCardSignal({
      signalId: params.signalId ?? "",
      visitor,
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
    return Response.json(result, {
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

export const loader = methods({ DELETE: detach });
export const action = loader;
