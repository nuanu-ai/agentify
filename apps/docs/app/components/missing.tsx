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

/**
 * The page for an address the documentation has no page at, in the panel the
 * scanner's and the dashboard's own such pages use. It stands outside the
 * reading layout, whose rules for an article's headings, paragraphs and links
 * would restyle the panel's.
 */
export function Missing() {
  return (
    <main className="message-page" id="main">
      <section className="message-panel">
        <h1>Page not found</h1>
        <p>There is no page at this address. It may have moved.</p>
        <Link className="button button-primary" to="/">
          Back to the documentation
        </Link>
      </section>
    </main>
  );
}
