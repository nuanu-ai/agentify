import type { NextRequest } from "next/server";

import { REPORT_SESSION_COOKIE } from "../../../../../../../lib/server/auth";
import { getServerConfig } from "../../../../../../../lib/server/config";
import { errorResponse } from "../../../../../../../lib/server/http";
import { markdownDownloadResponse } from "../../../../../../../lib/server/markdown-download";
import { getTeaserRemediationPrompt } from "../../../../../../../lib/server/remediation";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!getServerConfig().REMEDIATION_PROMPT_ENABLED)
    return errorResponse(request, 404, "not_found", "Prompt export is disabled.");
  const { id } = await params;
  const result = await getTeaserRemediationPrompt(
    id,
    request.cookies.get(REPORT_SESSION_COOKIE)?.value,
  );
  if (!result)
    return errorResponse(
      request,
      401,
      "contact_verification_required",
      "Confirm your email to download the prompt.",
    );
  return markdownDownloadResponse(result.content, "agentify-visible-findings-prompt.md");
}
