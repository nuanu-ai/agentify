/**
 * Any address under the workspace that matches none of its pages, said to an
 * operator in the workspace's own frame. Anybody else never gets this far:
 * the layout answers them as for every page of the workspace.
 */

import { data, Link } from "react-router";
import { AdminFrame } from "../../components/admin-frame.js";

export const loader = () => data(null, { status: 404 });

export const action = loader;

export default function NoSuchAdminPage() {
  return (
    <AdminFrame title="Page not found">
      <div className="message-panel">
        <p>There is no page at this address. The link may have a typo or be out of date.</p>
        <Link className="button button-primary" to="/admin">
          Back to the overview
        </Link>
      </div>
    </AdminFrame>
  );
}
