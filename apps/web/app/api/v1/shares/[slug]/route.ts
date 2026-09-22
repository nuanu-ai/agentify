import { type NextRequest, NextResponse } from "next/server";

import { getVerifiedSession, REPORT_SESSION_COOKIE } from "../../../../../lib/server/auth";
import { bearerToken, errorResponse, hasSameOrigin } from "../../../../../lib/server/http";
import { getPublicShare, revokePublicShare } from "../../../../../lib/server/reporting";
import { authorizeScan } from "../../../../../lib/server/scans";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const { slug } = await params;
  const share = await getPublicShare(slug);
  if (!share)
    return errorResponse(request, 404, "share_not_found", "The public link was not found.");
  const verified = await getVerifiedSession(
    request.cookies.get(REPORT_SESSION_COOKIE)?.value,
    share.scanId,
  );
  const bearer = bearerToken(request);
  const scanAuthorized = bearer ? Boolean(await authorizeScan(share.scanId, bearer)) : false;
  const result = await revokePublicShare(slug, {
    verifiedLeadId: verified?.leadId,
    scanTokenAuthorized: scanAuthorized,
  });
  if (result === "unauthorized")
    return errorResponse(request, 404, "share_not_found", "The public link was not found.");
  if (result === "not_found")
    return errorResponse(request, 404, "share_not_found", "The public link was not found.");
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}
