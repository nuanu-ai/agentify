import { NextResponse } from "next/server";

import { requestHeaders } from "../../../../lib/server/http";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return NextResponse.json(
    {
      status: "ok",
      service: "web",
      timestamp: new Date().toISOString(),
    },
    { headers: requestHeaders(request) },
  );
}
