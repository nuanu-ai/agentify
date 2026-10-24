/**
 * The workspace's Journal: every administrative action on the channel, newest
 * first. The layout above confirmed the operator before this runs.
 */

import { type LoaderFunctionArgs, useLoaderData } from "react-router";
import { readOnly } from "../../answer.js";
import { AdminFrame } from "../../components/admin-frame.js";
import { JournalScreen } from "../../screens/admin/journal.js";
import { workspaceIn } from "../../services.js";

export async function loader(asked: LoaderFunctionArgs) {
  const { admin, operator } = workspaceIn(asked.context);
  const { url } = asked;
  return await readOnly(() => admin.accounts.journal(operator, url.searchParams), asked);
}

export default function Journal() {
  const view = useLoaderData<typeof loader>();
  return (
    <AdminFrame section="journal" title="Journal">
      <JournalScreen view={view} />
    </AdminFrame>
  );
}
