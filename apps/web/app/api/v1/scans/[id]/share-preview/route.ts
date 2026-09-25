import { type NextRequest, NextResponse } from "next/server";

import { ownedLead, visitorOf } from "../../../../../../lib/server/auth";
import {
  bearerToken,
  errorResponse,
  visitorUnknownResponse,
} from "../../../../../../lib/server/http";
import { getPublicSharePreview } from "../../../../../../lib/server/reporting";
import { authorizeScan } from "../../../../../../lib/server/scans";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bearer = bearerToken(request);
  const scanAuthorized = bearer ? Boolean(await authorizeScan(id, bearer)) : false;
  const visitor = scanAuthorized ? undefined : await visitorOf(request.headers.get("cookie"));
  if (visitor?.kind === "unknown") return visitorUnknownResponse(request);
  const verified = visitor === undefined ? undefined : await ownedLead(visitor, id);
  if (!verified && !scanAuthorized)
    return errorResponse(request, 404, "scan_not_found", "The scan was not found.");
  const preview = await getPublicSharePreview(id);
  if (!preview)
    return errorResponse(request, 409, "share_unavailable", "This scan cannot be shared.");
  return NextResponse.json(preview, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
