import type { Params } from "react-router";
import { visitorOf } from "../../../../lib/server/auth";
import { getServerConfig } from "../../../../lib/server/config";
import { errorResponse, visitorUnknownResponse } from "../../../../lib/server/http";
import { markdownDownloadResponse } from "../../../../lib/server/markdown-download";
import { methods } from "../../../../lib/server/methods";
import { getTeaserRemediationPrompt } from "../../../../lib/server/remediation";

async function teaserPromptFile(request: Request, params: Params): Promise<Response> {
  if (!getServerConfig().REMEDIATION_PROMPT_ENABLED)
    return errorResponse(request, 404, "not_found", "Prompt export is disabled.");
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  const result = await getTeaserRemediationPrompt(params.id ?? "", visitor);
  if (!result)
    return errorResponse(
      request,
      401,
      "contact_verification_required",
      "Confirm your email to download the prompt.",
    );
  return markdownDownloadResponse(result.content, "agentify-visible-findings-prompt.md");
}

export const loader = methods({ GET: teaserPromptFile });
export const action = loader;
