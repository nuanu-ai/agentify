import { Form, Link } from "react-router";
import type { CutView, Listing } from "../../src/listing.js";
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
}: Readonly<{
  listing: Listing<unknown>;
  /** The list's page, without the dashboard's prefix. */
  path: string;
  /** What the search box is called, "Search cards". */
  label: string;
  placeholder: string;
}>) {
  const going = useGoingTo();
  const goingTo =
    going?.pathname === path ? (new URLSearchParams(going.search).get("show") ?? "") : null;
  const first = listing.segments[0]?.key;
  const marked = (key: string, here: boolean) =>
    goingTo === null ? here : goingTo === key || (goingTo === "" && key === first);
  return (
    <div className="list-tools">
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
    </div>
  );
}

/** Under a list cut short: which rows of how many, and the ways to the rest. */
export function CutNote({ cut }: Readonly<{ cut: CutView | null }>) {
  if (cut === null) return null;
  return (
    <nav className="cut" aria-label="Pages">
      <span>{`Showing ${cut.from}–${cut.to} of ${cut.of}`}</span>
      {cut.previous === null ? null : (
        <Link to={cut.previous} prefetch="intent">
          Previous
        </Link>
      )}
      {cut.next === null ? null : (
        <Link to={cut.next} prefetch="intent">
          Next
        </Link>
      )}
    </nav>
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
