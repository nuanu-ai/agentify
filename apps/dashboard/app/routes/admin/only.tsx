/**
 * The operator's workspace. Every page nested under this layout in
 * `routes.ts` is answered only for a signed-in account the operator flag
 * confirms on this very request, read before any loader or action of the page
 * runs, so a page added under it is guarded by being there. Anybody else, and
 * everybody while the identity cannot answer, is answered as an address the
 * dashboard does not have is answered them, so nothing tells the workspace
 * apart from a missing page; a visitor with no session meets the gate's
 * sign-in first. A press is a request like any other, so every press is
 * checked again.
 *
 * The workspace's pages run no script and load the workspace's stylesheets
 * after the dashboard's, the shared one first and then the dashboard's own, so
 * a merchant's page carries none of them.
 */

import workspaceSheet from "@agentify/visual/workspace.css?url";
import {
  data,
  type LoaderFunctionArgs,
  type MiddlewareFunction,
  Outlet,
  redirectDocument,
  type ShouldRevalidateFunction,
} from "react-router";
import adminSheet from "../../admin.css?url";
import { chromeOf, type Trouble } from "../../answer.js";
import { services, signedIn, workspace, workspaceIn } from "../../services.js";

/** Every post under it is handed to its middleware, so a post to a page that does not act is refused as any other. */
export const handle = { script: false, keepsData: false, takesEveryPost: true };

export const links = () => [
  { rel: "stylesheet", href: workspaceSheet },
  { rel: "stylesheet", href: adminSheet },
];

export const middleware: MiddlewareFunction<Response>[] = [
  async ({ request, context }, next) => {
    const pages = context.get(services);
    const door = pages.workspace;
    const opened =
      door === null ? null : await door.open(request.headers.get("cookie") ?? undefined);
    if (opened === null) {
      // What the merchant's pages' layout and its page for an unknown address
      // answer, with what their loaders read, since none runs after this.
      const person = context.get(signedIn);
      if (person.merchant === null) throw redirectDocument(`${pages.base}/merchant`, 303);
      throw data(
        {
          kind: "no-such-page",
          chrome: chromeOf(context),
          drawn: { who: person.email, framed: await pages.screens.frame(person) },
        } satisfies Trouble,
        { status: 404 },
      );
    }
    context.set(workspace, opened);
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
