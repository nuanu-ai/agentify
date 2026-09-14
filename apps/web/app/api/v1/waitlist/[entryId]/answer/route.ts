import { waitlistAnswerRequestSchema } from "@agentify/scanner-contracts";
import { type NextRequest, NextResponse } from "next/server";

import { REPORT_SESSION_COOKIE } from "../../../../../../lib/server/auth";
import {
  errorResponse,
  hasSameOrigin,
} from "../../../../../../lib/server/http";
import { saveWaitlistAnswer } from "../../../../../../lib/server/reporting";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ entryId: string }> },
) {
  if (!hasSameOrigin(request))
    return errorResponse(
      request,
      403,
      "invalid_origin",
      "The request origin is not allowed.",
    );
  const parsed = waitlistAnswerRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return errorResponse(
      request,
      400,
      "invalid_answer",
      "Answer must be 10 to 2000 characters.",
    );
  const { entryId } = await params;
  const saved = await saveWaitlistAnswer(
    entryId,
    parsed.data.answer,
    request.cookies.get(REPORT_SESSION_COOKIE)?.value,
  );
  if (!saved)
    return errorResponse(
      request,
      404,
      "waitlist_not_found",
      "The waitlist entry was not found.",
    );
  return NextResponse.json(
    { status: "saved" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
