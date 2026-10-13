import type { Params } from "react-router";
import { visitorOf } from "../../../../lib/server/auth";
import { getServerConfig } from "../../../../lib/server/config";
import { errorResponse, visitorUnknownResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { getFullRemediationPrompt } from "../../../../lib/server/remediation";

async function fullPrompt(request: Request, params: Params): Promise<Response> {
  if (!getServerConfig().REMEDIATION_PROMPT_ENABLED)
    return errorResponse(request, 404, "not_found", "Prompt export is disabled.");
  if (new URL(request.url).searchParams.get("scope") !== "full")
    return errorResponse(request, 400, "invalid_scope", "Expected scope=full.");
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  const result = await getFullRemediationPrompt(params.scanId ?? "", visitor);
  if (!result)
    return errorResponse(request, 404, "prompt_not_found", "No authorized prompt is available.");
  return Response.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export const loader = methods({ GET: fullPrompt });
export const action = loader;
