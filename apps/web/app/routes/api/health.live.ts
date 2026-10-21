import { getBrowserAnalyticsConfig } from "../../../lib/server/browser-analytics-config";
import { getServerConfig } from "../../../lib/server/config";
import { requestHeaders } from "../../../lib/server/http";
import { methods } from "../../../lib/server/methods";

function live(request: Request): Response {
  // Runtime configuration is part of whether this exact image can serve its
  // pages. Validate without contacting a database or external provider.
  try {
    getServerConfig();
    getBrowserAnalyticsConfig();
  } catch {
    return Response.json(
      { status: "configuration_invalid" },
      { status: 503, headers: requestHeaders(request) },
    );
  }
  return Response.json(
    {
      status: "ok",
      service: "web",
      timestamp: new Date().toISOString(),
    },
    { headers: requestHeaders(request) },
  );
}

export const loader = methods({ GET: live });
export const action = loader;
