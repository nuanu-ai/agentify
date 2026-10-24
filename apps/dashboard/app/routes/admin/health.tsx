/**
 * The workspace's health page, owned by the figures area, which
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
  return await readOnly(() => admin.figures.health(operator), asked);
}

export default function Health() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="health" title="Health">
      <Placeholder view={view} />
    </AdminFrame>
  );
}
