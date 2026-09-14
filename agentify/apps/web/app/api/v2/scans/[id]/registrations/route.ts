import {
  partnerClickIdSchema,
  registrationRequestSchema,
} from "@b2a/contracts";
import { type NextRequest, NextResponse } from "next/server";

import { getServerConfig } from "../../../../../../lib/server/config";
import {
  bearerToken,
  errorResponse,
  hasSameOrigin,
} from "../../../../../../lib/server/http";
import { authorizeScan } from "../../../../../../lib/server/scans";
import { createSupabaseRegistrationIntent } from "../../../../../../lib/server/supabase-registration";
import { PARTNER_CLICK_ID_COOKIE } from "../../../../../../lib/server/attribution";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!hasSameOrigin(request))
    return errorResponse(
      request,
      403,
      "invalid_origin",
      "The request origin is not allowed.",
    );
  if (!getServerConfig().REGISTRATION_ENABLED)
    return errorResponse(
      request,
      503,
      "registration_unavailable",
      "Contact verification is not enabled for this deployment yet.",
      true,
      3600,
    );
  const token = bearerToken(request);
  const { id } = await params;
  if (!token)
    return errorResponse(
      request,
      401,
      "unauthorized",
      "A private scan token is required.",
    );
  const scan = await authorizeScan(id, token);
  if (!scan)
    return errorResponse(
      request,
      404,
      "scan_not_found",
      "The scan was not found.",
    );
  if (scan.status !== "completed" && scan.status !== "partial")
    return errorResponse(
      request,
      409,
      "report_not_ready",
      "A report is not available for this scan.",
      true,
      5,
    );
  const parsed = registrationRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return errorResponse(
      request,
      400,
      "invalid_registration",
      "Check the email, international phone, and consent fields.",
    );
  try {
    const partnerClickId = partnerClickIdSchema.safeParse(
      request.cookies.get(PARTNER_CLICK_ID_COOKIE)?.value,
    );
    await createSupabaseRegistrationIntent(scan, parsed.data, {
      ...(partnerClickId.success
        ? { partnerClickId: partnerClickId.data }
        : {}),
    });
    return NextResponse.json(
      { status: "verification_sent" },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return errorResponse(
      request,
      503,
      "email_unavailable",
      "Verification email is temporarily unavailable.",
      true,
      60,
    );
  }
}
