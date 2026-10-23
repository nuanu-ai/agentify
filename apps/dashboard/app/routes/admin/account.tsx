/**
 * The workspace's account page, owned by the accounts area, which
 * replaces the placeholder with its screen. The layout above confirmed the
 * operator before this runs.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { Placeholder } from "../../components/admin/placeholder.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { params } = asked;
  return await readOnly(() => admin.accounts.one(operator, params.account_id ?? ""), asked);
}

export default function Account() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="accounts" title="Account">
      <Placeholder view={view} />
    </AdminFrame>
  );
}
