/**
 * Revoking one key, at once and for good. It draws no page and answers only
 * the press; a read of its address leads to the keys.
 */

import type { ActionFunctionArgs } from "react-router";
import { acted, readsLeadTo } from "../answer.js";
import { services, signedIn } from "../services.js";

export const middleware = readsLeadTo("/keys");

/**
 * A refusal or a failure is drawn as the pages' own. A route with neither a
 * page nor a boundary is one React Router answers them from as bare text.
 */
export { ErrorBoundary } from "../root.js";

export async function action(asked: ActionFunctionArgs) {
  const { params, context } = asked;
  return acted(
    async () =>
      await context.get(services).keys.disable(context.get(signedIn), params.key_id ?? ""),
    asked,
  );
}
