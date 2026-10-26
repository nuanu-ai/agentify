import { Form, Link } from "react-router";
import type { CutView, Listing, PageLink } from "../../src/listing.js";
import { useGoingTo } from "./going-to.js";
import { ListEmpty } from "./list.js";

/**
 * The search box and the segments over a long list. The search is a GET form
 * the loader answers, so it works without the page's script; it searches
 * within the segment shown and starts again at the first page. A segment
 * chosen is marked as soon as it is clicked, before its rows arrive.
 */
export function ListTools({
  listing,
  path,
  label,
  placeholder,
  searched,
  searchable = true,
}: Readonly<{
  listing: Listing<unknown>;
  /** The list's page, without the dashboard's prefix. */
  path: string;
  /** What the search box is called, "Search cards". */
  label: string;
  placeholder: string;
  /**
   * Where a search was made, the sentence saying what it reads and that the
   * counts are its own, given the words searched for; the way back to the
   * whole list follows it, unless the empty list under it offers that way.
   */
  searched?: (q: string) => string;
  /** False on a segment whose rows are read a page at a time and not searched. */
  searchable?: boolean;
}>) {
  const going = useGoingTo();
  const goingTo =
    going?.pathname === path ? (new URLSearchParams(going.search).get("show") ?? "") : null;
  const first = listing.segments[0]?.key;
  const marked = (key: string, here: boolean) =>
    goingTo === null ? here : goingTo === key || (goingTo === "" && key === first);
  return (
    <div className="list-tools">
      {searchable ? (
        <Form method="get" action={path} role="search" className="search">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            name="q"
            aria-label={label}
            placeholder={placeholder}
            defaultValue={listing.search.q}
            key={listing.search.q}
          />
          {listing.search.show === null ? null : (
            <input type="hidden" name="show" value={listing.search.show} />
          )}
        </Form>
      ) : null}
      <nav className="segments" aria-label="Show">
        {listing.segments.map((segment) =>
          marked(segment.key, segment.here) ? (
            <span key={segment.key} className="here" aria-current="page">
              {segment.label} <b>{segment.count}</b>
            </span>
          ) : (
            <Link key={segment.key} to={segment.to} prefetch="intent">
              {segment.label} <b>{segment.count}</b>
            </Link>
          ),
        )}
      </nav>
      {listing.search.cutAt === null ? null : (
        <p className="search-cut">
          {`Only the first ${listing.search.cutAt} characters of the search were used.`}
        </p>
      )}
      {searched === undefined || listing.search.q === "" ? null : (
        <p className="search-cut">
          {searched(listing.search.q)}
          {listing.nothing === null ? (
            <>
              {" "}
              <Link
                to={
                  listing.search.show === null
                    ? path
                    : `${path}?${new URLSearchParams({ show: listing.search.show })}`
                }
              >
                Clear the search
              </Link>
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}

/**
 * The list a press is made on, carried in its form, so the press leads back
 * to the search, the segment and the page the merchant was reading.
 */
export const KeptPlace = ({ place }: Readonly<{ place: Listing<unknown>["place"] }>) =>
  Object.entries(place).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} autoComplete="off" />
  ));

/** A way to the page before or after the one shown, and where there is none, its words in grey. */
interface PageStep {
  readonly to: string | null;
  readonly words: string;
}

const Step = ({ step, rel }: Readonly<{ step: PageStep; rel: "prev" | "next" }>) =>
  step.to === null ? (
    <span className={`pager-step ${rel}`} aria-disabled="true">
      {step.words}
    </span>
  ) : (
    <Link className={`pager-step ${rel}`} to={step.to} rel={rel} prefetch="intent">
      {step.words}
    </Link>
  );

/**
 * Under a list cut short, on one line where it fits: which rows of how many,
 * then the steps back and on, with the pages between them where the list can
 * name them; a list with nowhere to go says only the range. Every way is a
 * link the server answers, so it works before the page's script and can be
 * opened in a tab of its own.
 */
export function Pager({
  range,
  previous,
  next,
  pages = [],
}: Readonly<{ range: string; previous: PageStep; next: PageStep; pages?: readonly PageLink[] }>) {
  return (
    <nav className="cut pager" aria-label="Pages">
      <span className="pager-range">{range}</span>
      {previous.to === null && next.to === null && pages.length === 0 ? null : (
        <span className="pager-ways">
          <Step step={previous} rel="prev" />
          {pages.map((one, at) =>
            "gap" in one ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: a gap has no page of its own and the list never reorders
              <span key={`gap ${at}`} className="pager-gap" aria-hidden="true">
                …
              </span>
            ) : one.to === null ? (
              <span key={one.page} className="pager-page" aria-current="page">
                {one.page}
              </span>
            ) : (
              <Link
                key={one.page}
                className="pager-page"
                to={one.to}
                prefetch="intent"
                aria-label={`Page ${one.page}`}
              >
                {one.page}
              </Link>
            ),
          )}
          <Step step={next} rel="next" />
        </span>
      )}
    </nav>
  );
}

/** Under a list cut short: which rows of how many, and the ways to the rest. */
export function CutNote({ cut }: Readonly<{ cut: CutView | null }>) {
  if (cut === null) return null;
  return (
    <Pager
      range={`Showing ${cut.from}–${cut.to} of ${cut.of}`}
      previous={{ to: cut.previous, words: "Previous" }}
      next={{ to: cut.next, words: "Next" }}
      pages={cut.pages}
    />
  );
}

/**
 * In place of the rows where the list has some and none is drawn: a search
 * that matched nothing, or a segment that holds nothing, and the way out.
 */
export function NothingHere({ listing }: Readonly<{ listing: Listing<unknown> }>) {
  if (listing.nothing === null) return null;
  return (
    <ListEmpty>
      {listing.nothing.says}{" "}
      <Link to={listing.nothing.way.to} prefetch="intent">
        {listing.nothing.way.words}
      </Link>
      .
    </ListEmpty>
  );
}
