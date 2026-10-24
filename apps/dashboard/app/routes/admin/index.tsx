/**
 * The workspace's overview: what waits for the operator, what is worth a
 * look, and how the channel is doing. The layout above confirmed the operator
 * before this runs.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { OverviewScreen } from "../../screens/admin/figures.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { url } = asked;
  return await readOnly(() => admin.figures.overview(operator, url.searchParams), asked);
}

export default function Overview() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="overview" title="Overview">
      <OverviewScreen view={view} />
    </AdminFrame>
  );
}
