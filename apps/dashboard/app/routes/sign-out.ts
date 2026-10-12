/**
 * Signing out, in front of the gate so a tab whose session is gone can still
 * clear its cookie. It draws nothing and answers only the press; a read of its
 * address leads to the start, which every page's sign-out is pressed from.
 */

import type { ActionFunctionArgs } from "react-router";
import { acted, readsLeadTo } from "../answer.js";
import { services } from "../services.js";

export const middleware = readsLeadTo("/");

/**
 * A failure is drawn as the pages' own. A route with neither a page nor a
 * boundary is one React Router answers a failure from as bare text.
 */
export { ErrorBoundary } from "../root.js";

export async function action(asked: ActionFunctionArgs) {
  const { request, context } = asked;
  return acted(
    async () =>
      await context.get(services).signIn.signOut(request.headers.get("cookie") ?? undefined),
    asked,
  );
}
