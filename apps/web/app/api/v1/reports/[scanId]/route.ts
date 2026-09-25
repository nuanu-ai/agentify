import { type NextRequest, NextResponse } from "next/server";

import { visitorOf } from "../../../../../lib/server/auth";
import { errorResponse, visitorUnknownResponse } from "../../../../../lib/server/http";
import { getFullReport } from "../../../../../lib/server/reporting";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scanId: string }> },
) {
  const { scanId } = await params;
  const visitor = await visitorOf(request.headers.get("cookie"));
  if (visitor.kind === "unknown") return visitorUnknownResponse(request);
  const report = await getFullReport(scanId, visitor);
  if (!report)
    return errorResponse(
      request,
      404,
      "report_not_found",
      "The report is not available for this session.",
    );
  return NextResponse.json(report, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
