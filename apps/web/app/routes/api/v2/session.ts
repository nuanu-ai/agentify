import { visitorOf } from "../../../../lib/server/auth";
import { methods } from "../../../../lib/server/methods";

/**
 * Who is visiting, with their operator flag, for the header of every scanner
 * page.
 *
 * A separate same-origin call rather than an address drawn into the page, so
 * the public pages stay cacheable by a shared cache (`answer-headers.ts` marks
 * them `s-maxage=3600`) and only this uncached answer carries an address. For
 * the same reason it is the one scanner answer that renews the session and
 * passes the renewed cookie on: a page a shared cache keeps carries no cookie.
 */
async function session(request: Request): Promise<Response> {
  const visitor = await visitorOf(request.headers.get("cookie"), { renew: true });
  const headers = { "Cache-Control": "private, no-store" };
  if (visitor.kind === "unknown")
    return Response.json({ status: "unknown" }, { status: 503, headers });
  if (visitor.kind === "stranger") return Response.json({ status: "signed_out" }, { headers });
  const response = Response.json(
    { status: "signed_in", email: visitor.email, operator: visitor.operator },
    { headers },
  );
  for (const line of visitor.setCookies) response.headers.append("set-cookie", line);
  return response;
}

export const loader = methods({ GET: session });
export const action = loader;
