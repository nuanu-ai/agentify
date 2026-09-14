import { contactAccessResponseSchema } from "@b2a/contracts";
import { type NextRequest, NextResponse } from "next/server";

import { REPORT_SESSION_COOKIE } from "../../../../../../lib/server/auth";
import { getVerifiedSession } from "../../../../../../lib/server/auth";
import { errorResponse } from "../../../../../../lib/server/http";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const verified = await getVerifiedSession(
    request.cookies.get(REPORT_SESSION_COOKIE)?.value,
    id,
  );
  if (!verified)
    return errorResponse(
      request,
      401,
      "contact_verification_required",
      "Confirm your email to copy or download the prompt.",
    );
  return NextResponse.json(
    contactAccessResponseSchema.parse({ status: "verified" }),
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
