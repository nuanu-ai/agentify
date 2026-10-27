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

/** An identifier as a cursor carries it: any printable text, dots included, within a bound. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const ID = /^[^\u0000-\u001f\u007f]{1,256}$/;

const WHOLE = /^-?\d{1,16}$/;

/** The latest moment a date can hold, and the furthest any key reaches either way. */
const FURTHEST = 8.64e15;

/**
 * A place as an address writes it, for a list sorted by `keys` numbers: that
 * many whole numbers, then the identifier, which may hold dots of its own.
 * Null where the text is no such place, so that the address reads as the
 * first page.
 */
const markIn = (text: string, keys: number): Mark | null => {
  const parts = text.split(".");
  const key = parts.slice(0, keys).map((part) => (WHOLE.test(part) ? Number(part) : Number.NaN));
  const id = parts.slice(keys).join(".");
  return key.length === keys && ID.test(id) && key.every((one) => Math.abs(one) <= FURTHEST)
    ? { key, id }
    : null;
};

/**
 * A place as an address writes it, or null where a key is no whole number
 * within reach: its dot would be read back as the start of the identifier.
 */
const markText = (mark: Mark): string | null =>
  mark.key.every((one) => Number.isSafeInteger(one) && Math.abs(one) <= FURTHEST)
    ? [...mark.key, mark.id].join(".")
    : null;

/**
 * A value named once, as an address names it; named twice it is nobody's
 * choice, and is read as not named at all.
 */
export const once = (query: URLSearchParams, name: string): string | null => {
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

/**
 * Writes where a page stands into an address's fields; a place no address can
 * carry is left out, so the address reads as the first page.
 */
export const writeFrom = (fields: URLSearchParams, from: From): void => {
  if (from === null) return;
  const [name, mark] = "after" in from ? ["after", from.after] : ["before", from.before];
  const text = markText(mark);
  if (text !== null) fields.set(name, text);
};

/** Two places in the order a list sorted from the least holds them. */
export const rising = (one: Mark, other: Mark): number => {
  for (const [at, number] of one.key.entries()) {
    const difference = number - (other.key[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return one.id < other.id ? -1 : one.id > other.id ? 1 : 0;
};
