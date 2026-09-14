import { type NextRequest, NextResponse } from "next/server";

import {
  getVerifiedSession,
  REPORT_SESSION_COOKIE,
} from "../../../../../lib/server/auth";
import { errorResponse, hasSameOrigin } from "../../../../../lib/server/http";
import { updateAccountState } from "../../../../../lib/server/reporting";

export async function POST(request: NextRequest) {
  if (!hasSameOrigin(request))
    return errorResponse(
      request,
      403,
      "invalid_origin",
      "The request origin is not allowed.",
    );
  const verified = await getVerifiedSession(
    request.cookies.get(REPORT_SESSION_COOKIE)?.value,
  );
  if (!verified)
    return errorResponse(
      request,
      404,
      "session_not_found",
      "A verified session is required.",
    );
  await updateAccountState(verified.leadId, "unsubscribe");
  return NextResponse.json({ status: "unsubscribed" });
}
