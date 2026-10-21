/**
 * A long list as its address asks for it: the words searched for (`q`), the
 * segment shown (`show`) and the page (`page`), all read by the loader, so a
 * search is a plain GET that works without the page's script and a link to a
 * segment or a page can be fetched ahead. Every link keeps what the address
 * asked of the list except what the link changes, and a link back to the start
 * drops what is at its default, so the plain address is the plain list.
 *
 * A list cut short says how much was cut, and a search that matches nothing
 * says what was searched for, in a sentence of its own: "nothing matches" and
 * "nothing yet" are different claims.
 */

/** The most rows a page draws. */
export const PAGE_ROWS = 50;

/** What the address asks of the list. */
export interface Asked {
  readonly q: string;
  /** True where the address searched for more than `q` holds. */
  readonly cut: boolean;
  /** A segment's key; the first segment's where the address names none. */
  readonly show: string;
  readonly page: number;
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

/** Said under a list cut short: which rows are drawn of how many, and the ways to the rest. */
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
   * The search, the segment and the page drawn, each only where it is not the
   * default, as fields a form posted from the list carries back (`placeOf`).
   */
  readonly place: Readonly<Record<string, string>>;
}

/**
 * A value named once, as an address names it; named twice it is nobody's
 * choice, and is read as not named at all.
 */
const once = (query: URLSearchParams, name: string): string | null => {
  const values = query.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
};

/**
 * The most characters of a search that are matched and given back: more than
 * any name or code a merchant types, few enough that a pasted page does not
 * travel into every link and sentence.
 */
const Q_AT_MOST = 200;

/**
 * What an address asks of a list with these segments. A segment nobody
 * defined, and a page that is not a whole number from one, read as the
 * default.
 */
export const askedIn = (query: URLSearchParams, segments: readonly string[]): Asked => {
  const show = once(query, "show");
  const page = Number(once(query, "page") ?? "1");
  // By character, not by unit of the string, so no character is cut in half.
  const typed = [...(once(query, "q") ?? "").trim()];
  return {
    q: typed.slice(0, Q_AT_MOST).join("").trim(),
    cut: typed.length > Q_AT_MOST,
    show: show !== null && segments.includes(show) ? show : (segments[0] ?? ""),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
};

const fieldsOf = (asked: Asked, first: string): URLSearchParams => {
  const query = new URLSearchParams();
  if (asked.q !== "") query.set("q", asked.q);
  if (asked.show !== first) query.set("show", asked.show);
  if (asked.page !== 1) query.set("page", String(asked.page));
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
export const placeOf = (path: string, fields: URLSearchParams, segments: readonly string[]) =>
  addressOf(path, askedIn(fields, segments), segments[0] ?? "");

/**
 * The rows of `path`'s list that the address asks for. A page past the last
 * draws the last, so an address kept from a longer list still shows rows.
 */
export const listingOf = <Row>({
  rows,
  asked,
  path,
  segments,
  matches,
  noMatch,
  showAll,
}: Readonly<{
  rows: readonly Row[];
  asked: Asked;
  path: string;
  segments: readonly SegmentRule<Row>[];
  matches: (row: Row, words: string) => boolean;
  /** The sentence for a search with no match, given the segment's label. */
  noMatch: (q: string, within: string | null) => string;
  /** The words of the way from an empty segment to the first, "Show all cards". */
  showAll: string;
}>): Listing<Row> => {
  const first = segments[0]?.key ?? "";
  const words = asked.q.toLocaleLowerCase();
  const found = words === "" ? rows : rows.filter((row) => matches(row, words));
  const segment = segments.find((one) => one.key === asked.show) ?? segments[0];
  const shown = segment === undefined ? found : found.filter(segment.holds);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_ROWS));
  const page = Math.min(asked.page, pages);
  const start = (page - 1) * PAGE_ROWS;
  const at = (moved: Partial<Asked>) => addressOf(path, { ...asked, page, ...moved }, first);

  const nothing = (): Nothing | null => {
    if (shown.length > 0 || rows.length === 0) return null;
    if (asked.q !== "") {
      return {
        says: noMatch(asked.q, asked.show === first ? null : (segment?.label ?? null)),
        way: { to: at({ q: "", page: 1 }), words: "Clear the search" },
      };
    }
    return {
      says: segment?.none ?? "",
      way: { to: at({ show: first, page: 1 }), words: showAll },
    };
  };

  return {
    rows: shown.slice(start, start + PAGE_ROWS),
    search: {
      q: asked.q,
      show: asked.show === first ? null : asked.show,
      cutAt: asked.cut ? Q_AT_MOST : null,
    },
    segments: segments.map((one) => ({
      key: one.key,
      label: one.label,
      count: one.counted ?? found.filter(one.holds).length,
      to: at({ show: one.key, page: 1 }),
      here: one.key === segment?.key,
    })),
    cut:
      shown.length <= PAGE_ROWS
        ? null
        : {
            from: start + 1,
            to: Math.min(start + PAGE_ROWS, shown.length),
            of: shown.length,
            previous: page === 1 ? null : at({ page: page - 1 }),
            next: page === pages ? null : at({ page: page + 1 }),
          },
    nothing: nothing(),
    place: Object.fromEntries(fieldsOf({ ...asked, page }, first)),
  };
};

/**
 * The listing of a segment whose rows are read apart a page at a time: `rows`
 * is the page the address asks for, read already, and `of` how many the
 * segment holds in all. It is not searched, and a page past the last is the
 * last, as the reader of the rows is held to. `listing` is the list's own
 * listing for the same address, whose segments it keeps.
 */
export const pagedListingOf = <Row>({
  listing,
  rows,
  of,
  asked,
  path,
  first,
  none,
  showAll,
}: Readonly<{
  listing: Listing<Row>;
  rows: readonly Row[];
  of: number;
  asked: Asked;
  path: string;
  /** The key of the list's first segment, which an address leaves out. */
  first: string;
  none: string;
  showAll: string;
}>): Listing<Row> => {
  const pages = Math.max(1, Math.ceil(of / PAGE_ROWS));
  const page = Math.min(asked.page, pages);
  const start = (page - 1) * PAGE_ROWS;
  const here = { ...asked, q: "", cut: false, page };
  const at = (moved: Partial<Asked>) => addressOf(path, { ...here, ...moved }, first);
  return {
    rows,
    search: { q: "", show: asked.show === first ? null : asked.show, cutAt: null },
    segments: listing.segments,
    cut:
      of <= PAGE_ROWS
        ? null
        : {
            from: start + 1,
            to: Math.min(start + PAGE_ROWS, of),
            of,
            previous: page === 1 ? null : at({ page: page - 1 }),
            next: page === pages ? null : at({ page: page + 1 }),
          },
    nothing:
      of > 0 ? null : { says: none, way: { to: at({ show: first, page: 1 }), words: showAll } },
    place: Object.fromEntries(fieldsOf(here, first)),
  };
};
