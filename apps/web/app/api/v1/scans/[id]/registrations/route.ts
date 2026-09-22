import type { NextRequest } from "next/server";

import { errorResponse } from "../../../../../../lib/server/http";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  _context: { params: Promise<{ id: string }> },
) {
  return errorResponse(
    request,
    426,
    "registration_contract_upgraded",
    "Use the version 2 registration endpoint with email and phone.",
  );
}
