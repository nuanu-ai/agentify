/**
 * The workspace's Orders: the search across every merchant's orders. The
 * layout above confirmed the operator before this runs.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { readFailedIn } from "../../components/admin/read-failed.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { OrdersScreen } from "../../screens/admin/orders.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { url } = asked;
  return await readOnly(() => admin.orders.list(operator, url.searchParams), asked);
}

/** A read that failed, said in the workspace's frame. */
export const ErrorBoundary = readFailedIn({ section: "orders", title: "Orders" });

export default function Orders() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="orders" title="Orders">
      <OrdersScreen view={view} />
    </AdminFrame>
  );
}
