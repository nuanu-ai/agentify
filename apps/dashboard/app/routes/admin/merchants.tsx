/**
 * The workspace's merchants page, owned by the merchants area, which
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
  return await readOnly(() => admin.merchants.list(operator, url.searchParams), asked);
}

export default function Merchants() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="merchants" title="Merchants">
      <Placeholder view={view} />
    </AdminFrame>
  );
}
