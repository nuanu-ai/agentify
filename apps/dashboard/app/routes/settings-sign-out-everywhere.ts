/**
 * Signing the account out everywhere, the pressing browser included. It draws
 * nothing: the press leads to the sign-in page, and a read of its address
 * leads to the settings, which the press is made from.
 */

import type { ActionFunctionArgs } from "react-router";
import { acted, readsLeadTo } from "../answer.js";
import { services, signedIn } from "../services.js";

export const middleware = readsLeadTo("/settings");

/**
 * A failure is drawn as the pages' own. A route with neither a page nor a
 * boundary is one React Router answers a failure from as bare text.
 */
export { ErrorBoundary } from "../root.js";

export async function action(asked: ActionFunctionArgs) {
  const { context } = asked;
  return acted(
    async () => await context.get(services).settings.signOutEverywhere(context.get(signedIn)),
    asked,
  );
}
