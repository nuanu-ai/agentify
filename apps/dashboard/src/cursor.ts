/**
 * A long list's cursor as its address carries it. A page stands right after
 * a place in the list (`after`, the rows that follow it) or right before one
 * (`before`, the rows nearest it that precede it), and no cursor is the first
 * page. A place is written as the numbers the list is sorted by, then the
 * identifier of the row it was taken from, joined by dots:
 * `after=1787000000000.ord_b`. It names a place rather than a row, so it still
 * places the reader once that row has left the list or the segment.
 */

/** A place in a list: the numbers it is sorted by, in turn, then an identifier that breaks a tie. */
export interface Mark {
  readonly key: readonly number[];
  readonly id: string;
}

/** Where a page stands; null for the first page. */
export type From = Readonly<{ after: Mark }> | Readonly<{ before: Mark }> | null;

const ID = /^[A-Za-z0-9_-]{1,128}$/;

const WHOLE = /^-?\d{1,16}$/;

/** The latest moment a date can hold, and the furthest any key reaches either way. */
const FURTHEST = 8.64e15;

/**
 * A place as an address writes it, for a list sorted by `keys` numbers; null
 * where the text is no such place, so that the address reads as the first page.
 */
const markIn = (text: string, keys: number): Mark | null => {
  const parts = text.split(".");
  const id = parts.at(-1) ?? "";
  const key = parts.slice(0, -1).map((part) => (WHOLE.test(part) ? Number(part) : Number.NaN));
  return key.length === keys && ID.test(id) && key.every((one) => Math.abs(one) <= FURTHEST)
    ? { key, id }
    : null;
};

const markText = (mark: Mark): string => [...mark.key, mark.id].join(".");

/** A value the address names once; named twice it is nobody's choice. */
const once = (query: URLSearchParams, name: string): string | null => {
  const values = query.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
};

/**
 * Where the address asks a list sorted by `keys` numbers to stand. A cursor
 * that is no place, one named twice, and one each way at once read as the
 * first page.
 */
export const fromIn = (query: URLSearchParams, keys: number): From => {
  const after = once(query, "after");
  const before = once(query, "before");
  if (after !== null && !query.has("before")) {
    const mark = markIn(after, keys);
    return mark === null ? null : { after: mark };
  }
  if (before !== null && !query.has("after")) {
    const mark = markIn(before, keys);
    return mark === null ? null : { before: mark };
  }
  return null;
};

/** Writes where a page stands into an address's fields. */
export const writeFrom = (fields: URLSearchParams, from: From): void => {
  if (from === null) return;
  if ("after" in from) fields.set("after", markText(from.after));
  else fields.set("before", markText(from.before));
};
