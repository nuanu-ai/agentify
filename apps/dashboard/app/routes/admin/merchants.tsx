/**
 * The workspace's Merchants list: searched, narrowed to a segment and cut,
 * waiting for admission first. The layout above confirmed the operator before
 * this runs.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { readFailedIn } from "../../components/admin/read-failed.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { MerchantsScreen } from "../../screens/admin/merchants.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { url } = asked;
  return await readOnly(() => admin.merchants.list(operator, url.searchParams), asked);
}

/** A read that failed, said in the workspace's frame. */
export const ErrorBoundary = readFailedIn({ section: "merchants", title: "Merchants" });

export default function Merchants() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="merchants" title="Merchants">
      <MerchantsScreen view={view} />
    </AdminFrame>
  );
}
