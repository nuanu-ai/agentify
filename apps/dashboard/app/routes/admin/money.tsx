/**
 * The workspace's money: settled sales and commission over a period, the
 * splits and the operator's payout. The layout above confirmed the operator
 * before this runs.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { MoneyScreen } from "../../screens/admin/figures.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { url } = asked;
  return await readOnly(() => admin.figures.money(operator, url.searchParams), asked);
}

export default function Money() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="money" title="Money">
      <MoneyScreen view={view} />
    </AdminFrame>
  );
}
