/**
 * One account of the workspace, with its actions and its history. Each action
 * posts to an address of its own under this page (`account-press.tsx`), and
 * the page drawn after it is this one, read after the press, with the press's
 * answer beside the form that was pressed. The layout above confirmed the
 * operator before this runs.
 */

import { type LoaderFunctionArgs, Outlet, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { AccountScreen } from "../../screens/admin/accounts.js";
import { workspaceIn } from "../../services.js";
import { accountPressed } from "./account-press.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { params, context } = asked;
  return await readOnly(
    () => admin.accounts.one(operator, params.account_id ?? "", context.get(accountPressed)),
    asked,
  );
}

export default function Account() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame
      section="accounts"
      title="Account"
      heading={view.kind === "found" ? view.account.email : "No such account"}
    >
      <AccountScreen view={view} />
      <Outlet />
    </AdminFrame>
  );
}
