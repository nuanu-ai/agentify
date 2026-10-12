import { type NextRequest, NextResponse } from "next/server";

import { visitorOf } from "../../../../lib/server/auth";

export const runtime = "nodejs";

/**
 * Who is visiting, with their operator flag, for the header of every scanner
 * page.
 *
 * A separate same-origin call rather than an address drawn into the page, so
 * the public pages stay cacheable by a shared cache (`proxy.ts` marks them
 * `s-maxage=3600`) and only this uncached answer carries an address. It is also
 * the one scanner answer that renews the session and passes the renewed cookie
 * on, because a page drawn on the server cannot set a cookie.
 */
export async function GET(request: NextRequest) {
  const visitor = await visitorOf(request.headers.get("cookie"), { renew: true });
  const headers = { "Cache-Control": "private, no-store" };
  if (visitor.kind === "unknown")
    return NextResponse.json({ status: "unknown" }, { status: 503, headers });
  if (visitor.kind === "stranger") return NextResponse.json({ status: "signed_out" }, { headers });
  const response = NextResponse.json(
    { status: "signed_in", email: visitor.email, operator: visitor.operator },
    { headers },
  );
  for (const line of visitor.setCookies) response.headers.append("set-cookie", line);
  return response;
}
