import { accountDataRequestSchema } from "@b2a/contracts";
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
  const parsed = accountDataRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return errorResponse(
      request,
      400,
      "invalid_data_request",
      "The request type is invalid.",
    );
  let status: "requested" | "completed";
  try {
    status = await updateAccountState(verified.leadId, parsed.data.type);
  } catch {
    return errorResponse(
      request,
      503,
      "deletion_cleanup_failed",
      "Deletion was not finalized because provider cleanup could not be verified. Retry or contact privacy support.",
      true,
      60,
    );
  }
  const response = NextResponse.json({
    status,
    type: parsed.data.type,
  });
  if (parsed.data.type === "deletion")
    response.cookies.delete(REPORT_SESSION_COOKIE);
  return response;
}
