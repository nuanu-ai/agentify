import { type NextRequest, NextResponse } from "next/server";

import { visitorOf } from "../../../../lib/server/auth";

export const runtime = "nodejs";

/**
 * Who is visiting, for the header of every scanner page.
 *
 * A small same-origin call rather than an address drawn into the page, so the
 * public pages stay what a shared cache may keep (`proxy.ts` marks them
 * `s-maxage=3600`) and the one answer that carries an address is this one,
 * which no shared cache stores. It is also the one scanner answer that asks
 * the cabinet to renew the session and passes the renewed cookie on, since a
 * page drawn on the server cannot set a cookie: every visit to a page with a
 * header counts toward the thirty days (ADR-0026 §2, §3).
 */
export async function GET(request: NextRequest) {
  const visitor = await visitorOf(request.headers.get("cookie"), { renew: true });
  const headers = { "Cache-Control": "private, no-store" };
  if (visitor.kind === "unknown")
    return NextResponse.json({ status: "unknown" }, { status: 503, headers });
  if (visitor.kind === "stranger") return NextResponse.json({ status: "signed_out" }, { headers });
  const response = NextResponse.json({ status: "signed_in", email: visitor.email }, { headers });
  for (const line of visitor.setCookies) response.headers.append("set-cookie", line);
  return response;
}
