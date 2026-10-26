/**
 * One merchant's page in the workspace. Its presses each have a route of
 * their own beside it (`merchant-admit`, `merchant-withdraw`,
 * `merchant-key-disable`), each answered with this page in its new state. The
 * layout above confirmed the operator before this runs.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { readFailedIn } from "../../components/admin/read-failed.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { MerchantScreen } from "../../screens/admin/merchants.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { params } = asked;
  return await readOnly(() => admin.merchants.one(operator, params.merchant_id ?? ""), asked);
}

/** A read that failed, said in the workspace's frame. */
export const ErrorBoundary = readFailedIn({
  section: "merchants",
  title: "Merchant",
  back: { to: "/admin/merchants", words: "All merchants" },
});

export default function Merchant() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="merchants" title={view.name}>
      <MerchantScreen view={view} />
    </AdminFrame>
  );
}
