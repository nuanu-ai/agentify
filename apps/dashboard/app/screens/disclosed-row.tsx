import type { ReactNode } from "react";
import { shortened } from "../display/copy.js";

const Chevron = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/**
 * A row that opens, on every width, to what its line leaves out. A press
 * anywhere on the line opens it, which the browser does with no script on the
 * page; the chevron at the line's end shows that it opens and turns when it
 * is open. A link or a button in a cell stays its own. `of` names the press:
 * the row's title, its day and time, and its record's short ID, since two
 * purchases of one product can share the second, so a list of them read out
 * tells its rows apart. `id` is the row's address, which the page scrolls to
 * with the row's line in view, and `open` draws it opened.
 */
export function DisclosedRow({
  of,
  id,
  open,
  needsYou = false,
  cells,
  children,
}: Readonly<{
  of: Readonly<{ title: string; day: string; time: string; id: string }>;
  id: string;
  open?: boolean;
  needsYou?: boolean;
  cells: ReactNode;
  children: ReactNode;
}>) {
  return (
    <li id={id} className={needsYou ? "list-opens needs-you" : "list-opens"}>
      <div className="list-row">
        {cells}
        <span className="cell cell-chevron" aria-hidden="true">
          <Chevron />
        </span>
      </div>
      <details open={open} className="row-more">
        <summary
          aria-label={`Details of ${of.title}, ${of.day}, ${of.time}, ${shortened(of.id)}`}
        />
        <div className="more-body">{children}</div>
      </details>
    </li>
  );
}
