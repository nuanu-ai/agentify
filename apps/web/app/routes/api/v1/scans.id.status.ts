import type { Params } from "react-router";
import { bearerToken, errorResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { getScanStatus } from "../../../../lib/server/scans";

async function status(request: Request, params: Params): Promise<Response> {
  const token = bearerToken(request);
  if (!token)
    return errorResponse(request, 401, "unauthorized", "A private scan token is required.");
  const result = await getScanStatus(params.id ?? "", token);
  if (!result) return errorResponse(request, 404, "scan_not_found", "The scan was not found.");
  return Response.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export const loader = methods({ GET: status });
export const action = loader;
