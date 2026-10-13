import type { Params } from "react-router";
import { visitorOf } from "../../../../lib/server/auth";
import { getServerConfig } from "../../../../lib/server/config";
import { errorResponse, visitorUnknownResponse } from "../../../../lib/server/http";
import { methods } from "../../../../lib/server/methods";
import { getTeaserRemediationPrompt } from "../../../../lib/server/remediation";

async function teaserPrompt(request: Request, params: Params): Promise<Response> {
  if (!getServerConfig().REMEDIATION_PROMPT_ENABLED)
    return errorResponse(request, 404, "not_found", "Prompt export is disabled.");
  if (new URL(request.url).searchParams.get("scope") !== "teaser")
    return errorResponse(request, 400, "invalid_scope", "Expected scope=teaser.");
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  const result = await getTeaserRemediationPrompt(params.id ?? "", visitor);
  if (!result)
    return errorResponse(
      request,
      401,
      "contact_verification_required",
      "Confirm your email to copy or download the prompt.",
    );
  return Response.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export const loader = methods({ GET: teaserPrompt });
export const action = loader;
