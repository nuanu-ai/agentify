import { Link } from "react-router";
import { Reading } from "./reading.js";

/** The page drawn where a page could not be: the documentation may have changed since this tab opened, or the connection dropped. */
export function Unavailable() {
  return (
    <Reading current={null} sections={[]}>
      <div className="eyebrow">Documentation</div>
      <div className="doc">
        <h1>This page could not be loaded</h1>
        <p>
          The documentation may have changed since this page was opened, or the connection dropped.
          Reloading the page tries again.
        </p>
        <p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => window.location.reload()}
          >
            Reload the page
          </button>
        </p>
      </div>
    </Reading>
  );
}

/** The page for an address the documentation has no page at. */
export function Missing() {
  return (
    <Reading current={null} sections={[]}>
      <div className="eyebrow">Documentation</div>
      <div className="doc">
        <h1>There is no such page</h1>
        <p>
          The documentation has no page at this address. Its pages are listed beside this one, and
          its front page is <Link to="/">Connecting to Agentify</Link>.
        </p>
      </div>
    </Reading>
  );
}
