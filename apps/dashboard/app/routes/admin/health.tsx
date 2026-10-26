/**
 * The workspace's health: every moving part the application reads, the two
 * checks it runs again at a press, and the parts it cannot see. The layout
 * above confirmed the operator before this runs. A Check now press posts
 * here and is answered with the page carrying that check's answer.
 */

import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  useActionData,
  useLoaderData,
} from "react-router";
import { acted, formOf, readOnly } from "../../answer.js";
import { readFailedIn } from "../../components/admin/read-failed.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { HealthScreen } from "../../screens/admin/figures.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  return await readOnly(() => admin.figures.health(operator), asked);
}

export async function action(asked: ActionFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const form = await formOf(asked.request);
  return await acted(() => admin.figures.check(operator, form), asked);
}

/** A read that failed, said in the workspace's frame. */
export const ErrorBoundary = readFailedIn({ section: "health", title: "Health" });

export default function Health() {
  const loaded = useLoaderData<typeof loader>();
  const pressed = useActionData<typeof action>();
  return (
    <AdminFrame section="health" title="Health">
      <HealthScreen view={pressed ?? loaded} />
    </AdminFrame>
  );
}
