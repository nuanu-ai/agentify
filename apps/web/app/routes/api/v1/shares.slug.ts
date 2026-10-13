import type { Params } from "react-router";
import { ownedLead, visitorOf } from "../../../../lib/server/auth";
import {
  bearerToken,
  errorResponse,
  hasSameOrigin,
  visitorUnknownResponse,
} from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { getPublicShare, revokePublicShare } from "../../../../lib/server/reporting";
import { authorizeScan } from "../../../../lib/server/scans";

async function revoke(request: Request, params: Params): Promise<Response> {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const slug = params.slug ?? "";
  const share = await getPublicShare(slug);
  if (!share)
    return errorResponse(request, 404, "share_not_found", "The public link was not found.");
  const bearer = bearerToken(request);
  const scanAuthorized = bearer ? Boolean(await authorizeScan(share.scanId, bearer)) : false;
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown" && !scanAuthorized) return visitorUnknownResponse(request);
  const result = await revokePublicShare(slug, {
    verifiedLeadId: await ownedLead(visitor, share.scanId),
    scanTokenAuthorized: scanAuthorized,
  });
  if (result === "unauthorized")
    return errorResponse(request, 404, "share_not_found", "The public link was not found.");
  if (result === "not_found")
    return errorResponse(request, 404, "share_not_found", "The public link was not found.");
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

export const loader = methods({ DELETE: revoke });
export const action = loader;
