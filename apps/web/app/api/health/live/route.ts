import { NextResponse } from "next/server";

import { getBrowserAnalyticsConfig } from "../../../../lib/server/browser-analytics-config";
import { getServerConfig } from "../../../../lib/server/config";
import { getStripeCardSignalConfig } from "../../../../lib/server/stripe-card-signal-config";

import { requestHeaders } from "../../../../lib/server/http";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  // Runtime configuration is part of whether this exact image can serve its
  // pages. Validate without contacting a database or external provider.
  try {
    getServerConfig();
    getBrowserAnalyticsConfig();
    getStripeCardSignalConfig();
  } catch {
    return NextResponse.json(
      { status: "configuration_invalid" },
      { status: 503, headers: requestHeaders(request) },
    );
  }
  return NextResponse.json(
    {
      status: "ok",
      service: "web",
      timestamp: new Date().toISOString(),
    },
    { headers: requestHeaders(request) },
  );
}
