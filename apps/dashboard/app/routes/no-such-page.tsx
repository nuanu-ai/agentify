/**
 * Any address under the dashboard that matches none of its routes. It stands
 * inside the gates, so a visitor with no session who opens it is sent to the
 * sign-in as from any page; somebody signed in is told in the dashboard's own
 * frame, with its menu and a way back. A form sent here is answered the same
 * way, since nothing here acts.
 */

import { data, useRouteLoaderData } from "react-router";
import type { Chrome, DrawnFor } from "../answer.js";
import { Frame } from "../components/frame.js";

export const loader = () => data(null, { status: 404 });

export const action = loader;

/** `drawn` is what the loaders would have read, for this page drawn where none ran. */
export function NoSuchPage({
  drawn,
}: Readonly<{ drawn?: DrawnFor & Readonly<{ chrome: Chrome }> }>) {
  const base = (useRouteLoaderData<Chrome>("root") ?? drawn?.chrome)?.base ?? "";
  return (
    <Frame title="There is no such page" {...(drawn === undefined ? {} : { drawn })}>
      <div className="lede">
        <div>
          <p>
            The link may have a typo or be out of date. Every section of your dashboard is in the
            menu.
          </p>
        </div>
      </div>
      <div className="connect-actions">
        <a className="button button-primary" href={`${base}/cards`}>
          Back to the dashboard
        </a>
      </div>
    </Frame>
  );
}

export default function NoSuchPageRoute() {
  return <NoSuchPage />;
}
