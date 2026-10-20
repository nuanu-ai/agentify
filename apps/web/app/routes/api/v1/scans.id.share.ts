import { createShareRequestSchema } from "@agentify/scanner-contracts";
import type { Params } from "react-router";
import { ownedLead, visitorOf } from "../../../../lib/server/auth";
import { getServerConfig } from "../../../../lib/server/config";
import {
  bearerToken,
  errorResponse,
  hasSameOrigin,
  visitorUnknownResponse,
} from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { createPublicShare } from "../../../../lib/server/reporting";
import { authorizeScan } from "../../../../lib/server/scans";

async function share(request: Request, params: Params): Promise<Response> {
  if (!hasSameOrigin(request))
    return errorResponse(request, 403, "invalid_origin", "The request origin is not allowed.");
  const id = params.id ?? "";
  const parsed = createShareRequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success)
    return errorResponse(request, 400, "invalid_share_request", "The share request is invalid.");
  const bearer = bearerToken(request);
  const scanAuthorized = bearer ? Boolean(await authorizeScan(id, bearer)) : false;
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown" && !scanAuthorized) return visitorUnknownResponse(request);
  const verifiedLeadId = await ownedLead(visitor, id);
  if (!verifiedLeadId && !scanAuthorized)
    return errorResponse(request, 404, "scan_not_found", "The scan was not found.");
  const result = await createPublicShare(
    id,
    { verifiedLeadId, scanTokenAuthorized: scanAuthorized },
    parsed.data.allow_indexing,
  );
  if (!result)
    return errorResponse(request, 409, "share_unavailable", "This scan cannot be shared.");
  return Response.json(
    {
      slug: result.slug,
      public_url: `${getServerConfig().appBaseUrl}/s/${result.slug}`,
      status: "published",
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

export const loader = methods({ POST: share });
export const action = loader;
