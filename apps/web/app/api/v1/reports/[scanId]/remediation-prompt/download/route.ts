import type { NextRequest } from "next/server";
import { visitorOf } from "../../../../../../../lib/server/auth";
import { getServerConfig } from "../../../../../../../lib/server/config";
import { errorResponse, visitorUnknownResponse } from "../../../../../../../lib/server/http";
import { markdownDownloadResponse } from "../../../../../../../lib/server/markdown-download";
import { getFullRemediationPrompt } from "../../../../../../../lib/server/remediation";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scanId: string }> },
) {
  if (!getServerConfig().REMEDIATION_PROMPT_ENABLED)
    return errorResponse(request, 404, "not_found", "Prompt export is disabled.");
  const { scanId } = await params;
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  const result = await getFullRemediationPrompt(scanId, visitor);
  if (!result)
    return errorResponse(request, 404, "prompt_not_found", "No authorized prompt is available.");
  return markdownDownloadResponse(result.content, "agentify-complete-implementation-prompt.md");
}
