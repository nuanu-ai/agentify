/**
 * The workspace's overview page, owned by the figures area, which
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
  const { url } = asked;
  return await readOnly(() => admin.figures.overview(operator, url.searchParams), asked);
}

export default function Overview() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="overview" title="Overview">
      <Placeholder view={view} />
    </AdminFrame>
  );
}
