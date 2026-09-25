import { type NextRequest, NextResponse } from "next/server";

import { visitorOf } from "../../../../../lib/server/auth";
import { errorResponse, hasSameOrigin } from "../../../../../lib/server/http";
import { updateAccountState } from "../../../../../lib/server/reporting";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown")
    return errorResponse(
      request,
      503,
      "visitor_unknown",
      "We cannot tell who is visiting right now, so nothing was changed. Try again shortly.",
      true,
      30,
    );
  if (visitor.kind === "stranger")
    return errorResponse(
      request,
      404,
      "session_not_found",
      "Sign in with the address your reports were sent to before making this request.",
    );
  if (visitor.leadId === null)
    return errorResponse(
      request,
      404,
      "no_reports_for_address",
      `No reports are filed under ${visitor.email}, so there is nothing here to act on for that address.`,
    );
  await updateAccountState(visitor.leadId, "unsubscribe");
  return NextResponse.json({ status: "unsubscribed" });
}
