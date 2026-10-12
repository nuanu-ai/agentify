/**
 * The gate: every page nested under this route in `routes.ts` needs a session,
 * and gets it from here rather than asking for one itself, so a page added
 * under it is guarded by being there. It decides with `gateFor` in
 * `src/gate.ts`. A form that posts is refused unless it was drawn for the
 * address signed in now, before any action reads it.
 */

import {
  data,
  type LoaderFunctionArgs,
  type MiddlewareFunction,
  Outlet,
  redirectDocument,
} from "react-router";
import { DRAWN_FOR } from "../../src/drawn-for.js";
import { chromeOf, type Trouble } from "../answer.js";
import { services, signedIn } from "../services.js";

const cookies = (lines: readonly string[]): Headers => {
  const headers = new Headers();
  for (const line of lines) headers.append("set-cookie", line);
  return headers;
};

/**
 * A form whose body cannot be read as a form carries no mark, and is refused;
 * so is one marked more than once, which no page draws.
 */
const drawnForIn = async (request: Request): Promise<unknown> => {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  try {
    const marks = (await request.clone().formData()).getAll(DRAWN_FOR);
    return marks.length === 1 ? marks[0] : undefined;
  } catch {
    return undefined;
  }
};

export const middleware: MiddlewareFunction<Response>[] = [
  async ({ request, url, context }, next) => {
    const pages = context.get(services);
    let answer: Awaited<ReturnType<typeof pages.gate>>;
    try {
      answer = await pages.gate({
        cookie: request.headers.get("cookie") ?? undefined,
        method: request.method,
        path: url.pathname,
        drawnFor: await drawnForIn(request),
      });
    } catch {
      // Nothing below this route has run, so the page drawn instead is given
      // what it needs here; the exception is not logged, for the reason the
      // server entry gives.
      console.error("[dashboard] a request failed");
      throw data({ kind: "broken", chrome: chromeOf(context) } satisfies Trouble, { status: 500 });
    }
    if (answer.kind === "signed-out") {
      // Sent as it is: React Router does not put its prefix on a redirect
      // thrown here, so the location already carries the dashboard's.
      throw redirectDocument(answer.location, { status: 303, headers: cookies(answer.setCookies) });
    }
    if (answer.kind === "not-drawn-for-you") {
      throw data(
        {
          kind: "not-drawn-for-you",
          chrome: chromeOf(context),
          who: answer.who,
          start: answer.start,
        } satisfies Trouble,
        { status: 409, headers: cookies(answer.setCookies) },
      );
    }
    context.set(signedIn, answer.person);
    const response = await next();
    // Once a day the read moves the session's end, and the browser must be
    // told or its cookie expires thirty days after sign-in however often its
    // person returns. The renewal goes before the page's own lines, so a page
    // that clears the session has the last word.
    const own = response.headers.getSetCookie();
    response.headers.delete("set-cookie");
    for (const line of [...answer.setCookies, ...own]) response.headers.append("set-cookie", line);
    return response;
  },
];

/**
 * The root's page for trouble, drawn from here for the pages behind the gate:
 * after a failed action React Router reads only the loaders above the boundary
 * that draws the failure, and the root's chrome is one of them only when that
 * boundary is below the root.
 */
export { ErrorBoundary } from "../root.js";

/** The address every page behind the gate is drawn for, and names. */
export const loader = ({ context }: LoaderFunctionArgs) => ({ who: context.get(signedIn).email });

export default function Gate() {
  return <Outlet />;
}
