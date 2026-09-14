import { createShareRequestSchema } from "@b2a/contracts";
import { type NextRequest, NextResponse } from "next/server";

import {
  getVerifiedSession,
  REPORT_SESSION_COOKIE,
} from "../../../../../../lib/server/auth";
import { getServerConfig } from "../../../../../../lib/server/config";
import {
  bearerToken,
  errorResponse,
  hasSameOrigin,
} from "../../../../../../lib/server/http";
import { createPublicShare } from "../../../../../../lib/server/reporting";
import { authorizeScan } from "../../../../../../lib/server/scans";

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
  const { id } = await params;
  const parsed = createShareRequestSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success)
    return errorResponse(
      request,
      400,
      "invalid_share_request",
      "The share request is invalid.",
    );
  const verified = await getVerifiedSession(
    request.cookies.get(REPORT_SESSION_COOKIE)?.value,
    id,
  );
  const bearer = bearerToken(request);
  const scanAuthorized = bearer
    ? Boolean(await authorizeScan(id, bearer))
    : false;
  if (!verified && !scanAuthorized)
    return errorResponse(
      request,
      404,
      "scan_not_found",
      "The scan was not found.",
    );
  const result = await createPublicShare(
    id,
    { verifiedLeadId: verified?.leadId, scanTokenAuthorized: scanAuthorized },
    parsed.data.allow_indexing,
  );
  if (!result)
    return errorResponse(
      request,
      409,
      "share_unavailable",
      "This scan cannot be shared.",
    );
  if (result.conflict)
    return errorResponse(
      request,
      409,
      "share_already_published",
      "A public link already exists.",
    );
  return NextResponse.json(
    {
      slug: result.slug,
      public_url: `${getServerConfig().appBaseUrl}/s/${result.slug}`,
      status: "published",
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
