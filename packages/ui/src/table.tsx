import type { ReactNode } from "react";

export interface TableCell {
  readonly content: ReactNode;
  /** The page's own class for the cell's kind of value, such as an amount. */
  readonly className?: string;
}

export interface TableRow {
  readonly key: string;
  readonly className?: string;
  readonly cells: readonly TableCell[];
}

/**
 * Every cell carries its column's head, because where the frame is too narrow
 * a row is drawn as a block of labelled values and the labels are the heads.
 * With no rows the table is replaced by the sentence that says so, which is
 * the caller's to word: "nothing yet" and "nothing matches" are different
 * claims.
 */
export function Table({
  columns,
  rows,
  empty,
}: Readonly<{ columns: readonly string[]; rows: readonly TableRow[]; empty: ReactNode }>) {
  if (rows.length === 0) {
    return (
      <div className="table-frame">
        <p className="table-empty">{empty}</p>
      </div>
    );
  }
  return (
    <div className="table-frame">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column, at) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a head may be empty, and the columns never reorder
              <th key={at}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={row.className}>
              {row.cells.map((cell, at) => {
                const head = columns[at] ?? "";
                return (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: a cell's place is its column
                    key={at}
                    className={cell.className}
                    data-label={head === "" ? undefined : head}
                  >
                    {cell.content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
