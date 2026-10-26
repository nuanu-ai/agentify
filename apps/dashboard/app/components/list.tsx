import type { CSSProperties, ReactNode } from "react";

/**
 * The working screens' lists: rows in one bordered surface, separated by
 * hairlines, never a card inside a card. One markup serves both widths, and
 * the stylesheet turns it where the list's own box is under 860 pixels.
 *
 * On a wide box a row is a grid whose columns the list names in `columns`, a
 * CSS grid template its head shares; a template whose fixed columns leave the
 * title less than about twelve characters' room at 860 pixels is too wide. On
 * a narrow box a row's cells stack in lines by the place each names: the title
 * and the amount, then the state and one fact, then the identifier and the
 * row's action, then a note, a sentence that takes a line of its own, then
 * the opened row with what the narrow row leaves out. A `main` cell holds
 * several places in one column on a wide box and lets them go to their lines
 * on a narrow one; an `aside` is drawn on a wide box only, so whatever it
 * says belongs in the opened row too.
 */

/** A column's head, said at the end of its column where the column's values are. */
export type ListHead = string | Readonly<{ text: string; end: true }>;

export function List({
  label,
  columns,
  head,
  children,
}: Readonly<{
  /** What a screen reader calls the list. */
  label: string;
  columns: string;
  /** The light row of heads over the columns, drawn on a wide box only. */
  head?: readonly ListHead[];
  children: ReactNode;
}>) {
  return (
    <div className="list-box" style={{ "--columns": columns } as CSSProperties}>
      <ul className="list" aria-label={label} tabIndex={-1}>
        {head === undefined ? null : (
          <li className="list-head" aria-hidden="true">
            {head.map((one, at) =>
              typeof one === "string" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the heads never reorder, and one may be empty
                <span key={at}>{one}</span>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: the heads never reorder, and one may be empty
                <span key={at} className="end">
                  {one.text}
                </span>
              ),
            )}
          </li>
        )}
        {children}
      </ul>
    </div>
  );
}

/**
 * `off` draws a row the merchant cannot act on as quieter; `needsYou` marks
 * one that needs them.
 */
export function Row({
  off = false,
  needsYou = false,
  children,
}: Readonly<{ off?: boolean; needsYou?: boolean; children: ReactNode }>) {
  const classes = ["list-row", ...(off ? ["off"] : []), ...(needsYou ? ["needs-you"] : [])];
  return <li className={classes.join(" ")}>{children}</li>;
}

/** Where a cell goes on a narrow box; see the list's own description. */
export type Place =
  | "main"
  | "title"
  | "aside"
  | "amount"
  | "state"
  | "fact"
  | "ident"
  | "action"
  | "note";

export function Cell({ at, children }: Readonly<{ at: Place; children: ReactNode }>) {
  return <div className={`cell cell-${at}`}>{children}</div>;
}

/**
 * The list's surface with only the sentence that says why it holds no rows,
 * which is the caller's to word: "nothing yet" and "nothing matches" are
 * different claims.
 */
export function ListEmpty({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="list-box">
      <div className="list list-empty">{children}</div>
    </div>
  );
}

/**
 * A day pulled out of the moments under it, across every column: a heading a
 * screen reader can move between, one level under the group's, or under the
 * page's own title where the list stands in no group.
 */
export function DayHeading({
  level = 3,
  children,
}: Readonly<{ level?: 2 | 3; children: ReactNode }>) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <li className="list-day">
      <Heading>{children}</Heading>
    </li>
  );
}

/**
 * What a narrow row leaves out, opened by a press on the row's last line;
 * drawn on a narrow box only, since a wide row shows all of it in its columns,
 * unless `wide` says a wide row has no column for it either and draws it too,
 * under its columns. `of` is the row's title, which the control's name carries
 * after the words on screen, so a list of them read out tells its rows apart.
 */
export function RowMore({
  summary,
  of,
  wide = false,
  id,
  open,
  className,
  children,
}: Readonly<{
  summary: string;
  of: string;
  wide?: boolean;
  id?: string;
  open?: boolean;
  className?: string;
  children: ReactNode;
}>) {
  return (
    <details
      id={id}
      open={open}
      className={`${wide ? "cell-more wide" : "cell-more"}${className === undefined ? "" : ` ${className}`}`}
    >
      <summary aria-label={`${summary} for ${of}`}>{summary}</summary>
      <div className="more-body">{children}</div>
    </details>
  );
}

const Chevron = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/**
 * A row that opens, on every width, to what its line leaves out. A press
 * anywhere on the line opens it, which the browser does with no script on the
 * page; the chevron at the line's end shows that it opens and turns when it
 * is open. A link or a button in a cell stays its own. `of` is the row's
 * title, which names the press, so a list of them read out tells its rows
 * apart; `id` is the address that opens it, and `open` draws it opened.
 */
export function DisclosedRow({
  of,
  id,
  open,
  needsYou = false,
  cells,
  children,
}: Readonly<{
  of: string;
  id: string;
  open?: boolean;
  needsYou?: boolean;
  cells: ReactNode;
  children: ReactNode;
}>) {
  return (
    <li className={needsYou ? "list-opens needs-you" : "list-opens"}>
      <div className="list-row">
        {cells}
        <span className="cell cell-chevron" aria-hidden="true">
          <Chevron />
        </span>
      </div>
      <details id={id} open={open} className="row-more">
        <summary aria-label={`Details of ${of}`} />
        <div className="more-body">{children}</div>
      </details>
    </li>
  );
}

/**
 * What a row's details hold, each fact a label beside its value, in the one
 * look every list's details share; on a narrow box the label goes over the
 * value.
 */
export const Facts = ({ children }: Readonly<{ children: ReactNode }>) => (
  <dl className="more-facts">{children}</dl>
);

export const Fact = ({ label, children }: Readonly<{ label: string; children: ReactNode }>) => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);

/**
 * A heading over a group of rows with how many there are; `warn` paints the
 * count in the colour of what costs the merchant money, and `aside` follows
 * the count, a hint or a link.
 */
export function Group({
  title,
  count,
  warn = false,
  aside,
  children,
}: Readonly<{
  title: string;
  count: number;
  warn?: boolean;
  aside?: ReactNode;
  children: ReactNode;
}>) {
  return (
    <section className="group">
      <div className="group-head">
        <h2>
          {title} <span className={warn ? "count warn" : "count"}>{count}</span>
        </h2>
        {aside === undefined ? null : <div className="group-aside">{aside}</div>}
      </div>
      {children}
    </section>
  );
}
