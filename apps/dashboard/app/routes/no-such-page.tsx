/**
 * Any address under the dashboard that matches none of its routes. It stands
 * inside the gates, so a visitor with no session who opens it is sent to the
 * sign-in as from any page; somebody signed in is told in the dashboard's own
 * frame, with its menu and a way back. A form sent here is answered the same
 * way, since nothing here acts.
 */

import { data } from "react-router";
import { useChrome } from "../answer.js";
import { Frame } from "../components/frame.js";

export const loader = () => data(null, { status: 404 });

export const action = loader;

export default function NoSuchPage() {
  const { base } = useChrome();
  return (
    <Frame title="There is no such page" frame={{ unnamed: false }}>
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
