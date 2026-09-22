import { type NextRequest, NextResponse } from "next/server";

import { bearerToken, errorResponse } from "../../../../../../lib/server/http";
import { getScanStatus } from "../../../../../../lib/server/scans";

export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = bearerToken(request);
  if (!token)
    return errorResponse(request, 401, "unauthorized", "A private scan token is required.");
  const { id } = await params;
  const result = await getScanStatus(id, token);
  if (!result) return errorResponse(request, 404, "scan_not_found", "The scan was not found.");
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
