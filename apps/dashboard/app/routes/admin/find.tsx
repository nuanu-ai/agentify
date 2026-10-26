/**
 * The workspace's lookup: one match opens its record, none says so and keeps
 * what was pasted, several are listed. The layout above confirmed the
 * operator before this runs.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { readFailedIn } from "../../components/admin/read-failed.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { FindScreen } from "../../screens/admin/orders.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { url } = asked;
  return await readOnly(() => admin.orders.find(operator, url.searchParams), asked);
}

/** A read that failed, said in the workspace's frame. */
export const ErrorBoundary = readFailedIn({ title: "Find a record" });

export default function Find() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame title="Find a record">
      <FindScreen view={view} />
    </AdminFrame>
  );
}
