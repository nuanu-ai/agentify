import { type NextRequest, NextResponse } from "next/server";

import { bearerToken, errorResponse } from "../../../../../../lib/server/http";
import { getBrowserObservationForScan } from "../../../../../../lib/server/scans";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = bearerToken(request);
  if (!token)
    return errorResponse(
      request,
      401,
      "unauthorized",
      "A private scan token is required.",
    );
  const { id } = await params;
  const result = await getBrowserObservationForScan(id, token);
  if (!result)
    return errorResponse(
      request,
      404,
      "browser_observation_not_found",
      "Browser observation is not available.",
    );
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
