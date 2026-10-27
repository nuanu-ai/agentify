/**
 * A long list as its address asks for it: the words searched for (`q`), the
 * segment shown (`show`) and where the page stands (`after` or `before`, a
 * cursor), all read by the loader, so a search is a plain GET that works
 * without the page's script and a link to a segment or a page can be fetched
 * ahead. Every link keeps what the address asked of the list except what the
 * link changes; a link to another search or segment starts at its first page,
 * and a link back to the start drops what is at its default, so the plain
 * address is the plain list.
 *
 * A page leads on from its last row and back from its first, never by a count
 * of rows, so a row that arrives between two clicks moves no other row.
 *
 * A list cut short says how much was cut, and a search that matches nothing
 * says what was searched for, in a sentence of its own: "nothing matches" and
 * "nothing yet" are different claims.
 */

import { asTyped } from "@agentify/ui/units";
import { type From, fromIn, type Mark, once, rising, writeFrom } from "./cursor.js";

/** The most rows a page draws. */
export const PAGE_ROWS = 50;

/** What the address asks of the list. */
export interface Asked {
  readonly q: string;
  /** True where the address searched for more than `q` holds. */
  readonly cut: boolean;
  /** A segment's key; the first segment's where the address names none. */
  readonly show: string;
  readonly from: From;
}

/**
 * One segment of the list: `holds` decides its rows, `none` is the sentence
 * for a segment with no row while others have some.
 */
export interface SegmentRule<Row> {
  readonly key: string;
  readonly label: string;
  readonly holds: (row: Row) => boolean;
  readonly none: string;
  /**
   * How many rows a segment holds whose rows are read apart, a page at a
   * time, rather than found among the list's own (`pagedListingOf`); such a
   * segment holds none of them.
   */
  readonly counted?: number;
}

/** A segment as the filter draws it, with how many rows it holds under the search. */
interface Segment {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly to: string;
  readonly here: boolean;
}

/**
 * Said under a list cut short: which rows are drawn of how many, counted in
 * the list as it was read for this page, and the addresses of the pages
 * before and after it, null at either end.
 */
export interface CutView {
  readonly from: number;
  readonly to: number;
  readonly of: number;
  readonly previous: string | null;
  readonly next: string | null;
}

/** Why a list that has rows draws none here, and the way to some. */
interface Nothing {
  readonly says: string;
  readonly way: Readonly<{ to: string; words: string }>;
}

export interface Listing<Row> {
  readonly rows: readonly Row[];
  /**
   * The search box's words, the segment it searches within, and the length
   * the words were cut to where the address held more; null where it did not.
   */
  readonly search: Readonly<{ q: string; show: string | null; cutAt: number | null }>;
  readonly segments: readonly Segment[];
  /** Null where every row the search and the segment hold is drawn. */
  readonly cut: CutView | null;
  /** Null where a row is drawn, or where the list has none at all. */
  readonly nothing: Nothing | null;
  /**
   * The search, the segment and the cursor of the page drawn, each only where
   * it is not the default, as fields a form posted from the list carries back
   * (`placeOf`).
   */
  readonly place: Readonly<Record<string, string>>;
}

/**
 * The most characters of a search that are matched and given back: more than
 * any name or code a merchant types, few enough that a pasted page does not
 * travel into every link and sentence.
 */
const Q_AT_MOST = 200;

/**
 * What an address asks of a list with these segments, sorted by `keys`
 * numbers. A segment nobody defined, and a cursor that is no place in such a
 * list, read as the default.
 */
export const askedIn = (query: URLSearchParams, segments: readonly string[], keys = 1): Asked => {
  const show = once(query, "show");
  // By character, not by unit of the string, so no character is cut in half.
  const typed = [...asTyped(once(query, "q") ?? "").trim()];
  return {
    q: typed.slice(0, Q_AT_MOST).join("").trim(),
    cut: typed.length > Q_AT_MOST,
    show: show !== null && segments.includes(show) ? show : (segments[0] ?? ""),
    from: fromIn(query, keys),
  };
};

const fieldsOf = (asked: Asked, first: string): URLSearchParams => {
  const query = new URLSearchParams();
  if (asked.q !== "") query.set("q", asked.q);
  if (asked.show !== first) query.set("show", asked.show);
  writeFrom(query, asked.from);
  return query;
};

const addressOf = (path: string, asked: Asked, first: string): string => {
  const written = fieldsOf(asked, first).toString();
  return written === "" ? path : `${path}?${written}`;
};

/**
 * Where a press made on `path`'s list leads back to: the list as the fields
 * its form carried name it, read as `askedIn` reads the list's own address, so
 * the merchant is shown the search, the segment and the page they pressed on
 * and a field nobody's list would draw is the default.
 */
export const placeOf = (
  path: string,
  fields: URLSearchParams,
  segments: readonly string[],
  keys = 1,
) => addressOf(path, askedIn(fields, segments, keys), segments[0] ?? "");

/**
 * Where the page `from` asks for starts and ends among `marks`, the list's
 * rows in its order: right after the cursor, or the rows nearest before it.
 * A cursor past either end draws the page at that end, so an address kept
 * from a longer list still shows rows.
 */
const cutIn = (
  marks: readonly Mark[],
  from: From,
  order: (one: Mark, other: Mark) => number,
): Readonly<{ start: number; end: number; from: From }> => {
  const first = { start: 0, end: Math.min(PAGE_ROWS, marks.length), from: null };
  if (from === null) return first;
  if ("after" in from) {
    const start = marks.findIndex((mark) => order(mark, from.after) > 0);
    if (start === -1) {
      const last = Math.max(0, marks.length - PAGE_ROWS);
      const before = marks[last - 1];
      return {
        start: last,
        end: marks.length,
        from: before === undefined ? null : { after: before },
      };
    }
    return { start, end: Math.min(start + PAGE_ROWS, marks.length), from };
  }
  const found = marks.findIndex((mark) => order(mark, from.before) >= 0);
  const end = found === -1 ? marks.length : found;
  return end === 0 ? first : { start: Math.max(0, end - PAGE_ROWS), end, from };
};

/**
 * The rows of `path`'s list that the address asks for, in the list's order:
 * newest first by the place `markOf` gives each row, the oldest first where
 * `oldestFirst`.
 */
export const listingOf = <Row>({
  rows,
  asked,
  path,
  segments,
  markOf,
  oldestFirst = false,
  matches,
  noMatch,
  showAll,
}: Readonly<{
  rows: readonly Row[];
  asked: Asked;
  path: string;
  segments: readonly SegmentRule<Row>[];
  /** Where a row stands in the list: the numbers it is sorted by, then its identifier. */
  markOf: (row: Row) => Mark;
  oldestFirst?: boolean;
  matches: (row: Row, words: string) => boolean;
  /** The sentence for a search with no match, given the segment's label. */
  noMatch: (q: string, within: string | null) => string;
  /** The words of the way from an empty segment to the first, "Show all products". */
  showAll: string;
}>): Listing<Row> => {
  const first = segments[0]?.key ?? "";
  const order = (one: Mark, other: Mark) => (oldestFirst ? rising(one, other) : rising(other, one));
  const words = asked.q.toLocaleLowerCase();
  const found = words === "" ? rows : rows.filter((row) => matches(row, words));
  const segment = segments.find((one) => one.key === asked.show) ?? segments[0];
  const shown = (segment === undefined ? found : found.filter(segment.holds))
    .map((row) => ({ row, mark: markOf(row) }))
    .sort((one, other) => order(one.mark, other.mark));
  const marks = shown.map((one) => one.mark);
  const cut = cutIn(marks, asked.from, order);
  const here = { ...asked, from: cut.from };
  const at = (moved: Partial<Asked>) => addressOf(path, { ...here, ...moved }, first);
  const opening = marks[cut.start];
  const closing = marks[cut.end - 1];

  const nothing = (): Nothing | null => {
    if (shown.length > 0 || rows.length === 0) return null;
    if (asked.q !== "") {
      return {
        says: noMatch(asked.q, asked.show === first ? null : (segment?.label ?? null)),
        way: { to: at({ q: "", from: null }), words: "Clear the search" },
      };
    }
    return {
      says: segment?.none ?? "",
      way: { to: at({ show: first, from: null }), words: showAll },
    };
  };

  return {
    rows: shown.slice(cut.start, cut.end).map((one) => one.row),
    search: {
      q: asked.q,
      show: asked.show === first ? null : asked.show,
      cutAt: asked.cut ? Q_AT_MOST : null,
    },
    segments: segments.map((one) => ({
      key: one.key,
      label: one.label,
      count: one.counted ?? found.filter(one.holds).length,
      to: at({ show: one.key, from: null }),
      here: one.key === segment?.key,
    })),
    cut:
      cut.start === 0 && cut.end === shown.length
        ? null
        : {
            from: cut.start + 1,
            to: cut.end,
            of: shown.length,
            previous:
              cut.start === 0 || opening === undefined ? null : at({ from: { before: opening } }),
            next:
              cut.end === shown.length || closing === undefined
                ? null
                : at({ from: { after: closing } }),
          },
    nothing: nothing(),
    place: Object.fromEntries(fieldsOf(here, first)),
  };
};

/**
 * The listing of a segment whose rows are read apart a page at a time: `rows`
 * is the page the address asks for, read already, `of` how many the segment
 * holds in all and `newer` how many come before the page, and `previous` and
 * `next` the places of its first and last rows where the segment goes on that
 * way. It is not searched. `listing` is the list's own listing for the same
 * address, whose segments it keeps.
 */
export const pagedListingOf = <Row>({
  listing,
  rows,
  of,
  newer,
  previous,
  next,
  asked,
  path,
  first,
  none,
  showAll,
}: Readonly<{
  listing: Listing<Row>;
  rows: readonly Row[];
  of: number;
  newer: number;
  previous: Mark | null;
  next: Mark | null;
  asked: Asked;
  path: string;
  /** The key of the list's first segment, which an address leaves out. */
  first: string;
  none: string;
  showAll: string;
}>): Listing<Row> => {
  const here = { ...asked, q: "", cut: false };
  const at = (moved: Partial<Asked>) => addressOf(path, { ...here, ...moved }, first);
  return {
    rows,
    search: { q: "", show: asked.show === first ? null : asked.show, cutAt: null },
    segments: listing.segments,
    cut:
      previous === null && next === null
        ? null
        : {
            from: newer + 1,
            to: newer + rows.length,
            of,
            previous: previous === null ? null : at({ from: { before: previous } }),
            next: next === null ? null : at({ from: { after: next } }),
          },
    nothing:
      of > 0 ? null : { says: none, way: { to: at({ show: first, from: null }), words: showAll } },
    place: Object.fromEntries(fieldsOf(here, first)),
  };
};
