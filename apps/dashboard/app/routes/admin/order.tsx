/**
 * The workspace's page of one order: what the agent and the merchant read,
 * its story, its payment and its receipt. The layout above confirmed the
 * operator before this runs.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { OrderScreen } from "../../screens/admin/orders.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { params } = asked;
  return await readOnly(() => admin.orders.one(operator, params.order_id ?? ""), asked);
}

export default function Order() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="orders" title={view.kind === "order" ? view.title : "Order"}>
      <OrderScreen view={view} />
    </AdminFrame>
  );
}
