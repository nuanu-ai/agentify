import type { Params } from "react-router";
import { bearerToken, errorResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { getBrowserObservationForScan } from "../../../../lib/server/scans";

async function browserObservation(request: Request, params: Params): Promise<Response> {
  const token = bearerToken(request);
  if (!token)
    return errorResponse(request, 401, "unauthorized", "A private scan token is required.");
  const result = await getBrowserObservationForScan(params.id ?? "", token);
  if (!result)
    return errorResponse(
      request,
      404,
      "browser_observation_not_found",
      "Browser observation is not available.",
    );
  return Response.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export const loader = methods({ GET: browserObservation });
export const action = loader;
