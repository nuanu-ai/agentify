import { Link } from "react-router";
import { Reading } from "./reading.js";

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
