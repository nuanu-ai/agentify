/**
 * Revoking one key, at once and for good. It draws no page and answers only
 * the press, so an address with nothing to read is answered as any unknown one
 * is.
 */

import type { ActionFunctionArgs } from "react-router";
import { answer } from "../answer.js";
import { services, signedIn } from "../services.js";

/**
 * A refusal is drawn as the pages' own. A route with neither a page nor a
 * boundary is one React Router sends its refusals from as data, which a
 * browser would show as text.
 */
export { ErrorBoundary } from "../root.js";

export async function action(asked: ActionFunctionArgs) {
  const { params, context } = asked;
  return answer(
    await context.get(services).keys.disable(context.get(signedIn), params.key_id ?? ""),
    asked,
  );
}
