/**
 * The workspace's Accounts: who made a merchant or holds the operator flag,
 * and whose sessions are open. The layout above confirmed the operator before
 * this runs.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { readFailedIn } from "../../components/admin/read-failed.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { AccountsScreen } from "../../screens/admin/accounts.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { url } = asked;
  return await readOnly(() => admin.accounts.list(operator, url.searchParams), asked);
}

/** A read that failed, said in the workspace's frame. */
export const ErrorBoundary = readFailedIn({ section: "accounts", title: "Accounts" });

export default function Accounts() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="accounts" title="Accounts">
      <AccountsScreen view={view} />
    </AdminFrame>
  );
}
