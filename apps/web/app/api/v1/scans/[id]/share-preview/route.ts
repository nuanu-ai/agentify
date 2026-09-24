import { type NextRequest, NextResponse } from "next/server";

import { signedInLead } from "../../../../../../lib/server/auth";
import { bearerToken, errorResponse } from "../../../../../../lib/server/http";
import { getPublicSharePreview } from "../../../../../../lib/server/reporting";
import { authorizeScan } from "../../../../../../lib/server/scans";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const verified = await signedInLead(request.headers.get("cookie"), id);
  const bearer = bearerToken(request);
  const scanAuthorized = bearer ? Boolean(await authorizeScan(id, bearer)) : false;
  if (!verified && !scanAuthorized)
    return errorResponse(request, 404, "scan_not_found", "The scan was not found.");
  const preview = await getPublicSharePreview(id);
  if (!preview)
    return errorResponse(request, 409, "share_unavailable", "This scan cannot be shared.");
  return NextResponse.json(preview, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
