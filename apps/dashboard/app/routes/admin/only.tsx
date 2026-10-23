/**
 * The operator's workspace. Every page nested under this layout in
 * `routes.ts` is answered only for a signed-in account the operator flag
 * confirms on this very request, read before any loader or action of the page
 * runs, so a page added under it is guarded by being there. Anybody else, and
 * everybody while the identity cannot answer, gets the site's "no such page";
 * a visitor with no session meets the gate's sign-in first. A press is a
 * request like any other, so every press is checked again.
 *
 * The workspace's pages run no script and load the workspace's stylesheet
 * after the dashboard's.
 */

import {
  data,
  type LoaderFunctionArgs,
  type MiddlewareFunction,
  Outlet,
  type ShouldRevalidateFunction,
} from "react-router";
import adminSheet from "../../admin.css?url";
import { chromeOf, type Trouble } from "../../answer.js";
import { operating, services, workspaceIn } from "../../services.js";

export const handle = { script: false, keepsData: false };

export const links = () => [{ rel: "stylesheet", href: adminSheet }];

export const middleware: MiddlewareFunction<Response>[] = [
  async ({ request, context }, next) => {
    const admin = context.get(services).admin;
    const operator =
      admin === null ? null : await admin.operatorOf(request.headers.get("cookie") ?? undefined);
    if (operator === null) {
      throw data(
        {
          kind: "problem",
          chrome: chromeOf(context),
          said: "There is no such page.",
        } satisfies Trouble,
        { status: 404 },
      );
    }
    context.set(operating, operator);
    return await next();
  },
];

/** The channel and each section's count, read for every page of the workspace. */
export async function loader({ context }: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(context);
  return await admin.frame(operator);
}

/** Read again on every move between pages and after every press. */
export const shouldRevalidate: ShouldRevalidateFunction = ({
  formMethod,
  defaultShouldRevalidate,
}) => formMethod === undefined || defaultShouldRevalidate;

export default function OperatorOnly() {
  return <Outlet />;
}
