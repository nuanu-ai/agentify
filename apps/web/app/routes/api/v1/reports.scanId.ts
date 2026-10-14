import type { Params } from "react-router";
import { visitorOf } from "../../../../lib/server/auth";
import { errorResponse, visitorUnknownResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { getFullReport } from "../../../../lib/server/reporting";

async function report(request: Request, params: Params): Promise<Response> {
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  const found = await getFullReport(params.scanId ?? "", visitor);
  if (!found)
    return errorResponse(
      request,
      404,
      "report_not_found",
      "The report is not available for this session.",
    );
  return Response.json(found, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export const loader = methods({ GET: report });
export const action = loader;
