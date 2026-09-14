import { type NextRequest, NextResponse } from "next/server";

import { REPORT_SESSION_COOKIE } from "../../../../../../lib/server/auth";
import { getServerConfig } from "../../../../../../lib/server/config";
import { errorResponse } from "../../../../../../lib/server/http";
import { getFullRemediationPrompt } from "../../../../../../lib/server/remediation";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scanId: string }> },
) {
  if (!getServerConfig().REMEDIATION_PROMPT_ENABLED)
    return errorResponse(
      request,
      404,
      "not_found",
      "Prompt export is disabled.",
    );
  if (request.nextUrl.searchParams.get("scope") !== "full")
    return errorResponse(request, 400, "invalid_scope", "Expected scope=full.");
  const { scanId } = await params;
  const result = await getFullRemediationPrompt(
    scanId,
    request.cookies.get(REPORT_SESSION_COOKIE)?.value,
  );
  if (!result)
    return errorResponse(
      request,
      404,
      "prompt_not_found",
      "No authorized prompt is available.",
    );
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
