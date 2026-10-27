/**
 * How a long list is read a page at a time: by a cursor taken from a row,
 * never by a count of rows to skip, so a row written between two reads is
 * neither read twice nor passed over.
 */

/**
 * Where a page stands in its list: right after the cursor, the rows that
 * follow it in the list's order, or right before it, the rows nearest it
 * that precede it. A cursor names a place by the list's sort key and an
 * identifier, not a row, so it still places the reader when the row it was
 * taken from has left the list.
 */
export type PageFrom<Cursor> = Readonly<{ after: Cursor }> | Readonly<{ before: Cursor }>;

/**
 * A page cut from rows held whole and in the list's order: at most `limit` of
 * them where `from` stands, how many rows come before the page, and the
 * page's first and last rows where the list goes on that way. `place` is below
 * nought for a row before the cursor, nought at it, and above nought after it.
 */
export function pageIn<Row, Cursor>(
  rows: readonly Row[],
  from: PageFrom<Cursor> | undefined,
  limit: number,
  place: (row: Row, cursor: Cursor) => number,
): Readonly<{ rows: Row[]; newer: number; previous: Row | null; next: Row | null }> {
  const firstFrom = (cursor: Cursor, at: (placed: number) => boolean) => {
    const found = rows.findIndex((row) => at(place(row, cursor)));
    return found === -1 ? rows.length : found;
  };
  let start = 0;
  let end = Math.min(limit, rows.length);
  if (from !== undefined && "after" in from) {
    start = firstFrom(from.after, (placed) => placed > 0);
    end = Math.min(start + limit, rows.length);
  } else if (from !== undefined) {
    end = firstFrom(from.before, (placed) => placed >= 0);
    start = Math.max(0, end - limit);
  }
  const page = rows.slice(start, end);
  return {
    rows: page,
    newer: start,
    previous: start > 0 ? (page[0] ?? null) : null,
    next: end < rows.length ? (page.at(-1) ?? null) : null,
  };
}

/** Two identifiers by their bytes, as Postgres compares them under the "C" collation. */
export const byBytes = (one: string, other: string): number =>
  one < other ? -1 : one > other ? 1 : 0;
