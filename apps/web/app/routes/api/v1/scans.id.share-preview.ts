import type { Params } from "react-router";

import { ownedLead, visitorOf } from "../../../../lib/server/auth";
import { bearerToken, errorResponse, visitorUnknownResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { getPublicSharePreview } from "../../../../lib/server/reporting";
import { authorizeScan } from "../../../../lib/server/scans";

async function preview(request: Request, { id = "" }: Params): Promise<Response> {
  const bearer = bearerToken(request);
  const scanAuthorized = bearer ? Boolean(await authorizeScan(id, bearer)) : false;
  const visitor = scanAuthorized ? undefined : await visitorOf(request.headers.get("cookie"));
  if (visitor?.kind === "unknown") return visitorUnknownResponse(request);
  const verified = visitor === undefined ? undefined : await ownedLead(visitor, id);
  if (!verified && !scanAuthorized)
    return errorResponse(request, 404, "scan_not_found", "The scan was not found.");
  const snapshot = await getPublicSharePreview(id);
  if (!snapshot)
    return errorResponse(request, 409, "share_unavailable", "This scan cannot be shared.");
  return Response.json(snapshot, { headers: { "Cache-Control": "private, no-store" } });
}

export const loader = methods({ GET: preview });
export const action = loader;
