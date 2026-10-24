/**
 * The press of the step that asks for a fresh sign-in: a link mailed to the
 * operator's own address, which signs this browser in again and returns it to
 * the page the action was pressed on. It answers with the step drawn on a page
 * of its own, saying what became of the link. A read of this address leads to
 * the overview, since nothing was pressed.
 */

import { type ActionFunctionArgs, Link, useActionData } from "react-router";
import { acted, formOf, readsLeadTo } from "../../answer.js";
import { StepUp } from "../../components/admin/step-up.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { workspaceIn } from "../../services.js";

export const middleware = readsLeadTo("/admin");

export async function action(asked: ActionFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const form = await formOf(asked.request);
  return await acted(() => admin.signInAgain.press(operator, form), asked);
}

export default function SignInAgain() {
  const view = useActionData<typeof action>();
  if (view === undefined) throw new Error("the step was drawn without a press");
  return (
    <AdminFrame title="Confirm it is you">
      <div className="op-decide">
        <StepUp view={view} />
      </div>
      <p className="op-sub">
        <Link to={`/${view.destination}`}>Back to the page you were on</Link>
      </p>
    </AdminFrame>
  );
}
