/**
 * The search, loaded with its index the first time a reader opens it. Each
 * result names the headings it sits under and shows the words around the
 * first match, every matched word marked. The query is kept in the tab's
 * browser, so the search opens on it again after a move or a reload. The
 * input is a combobox over a list of results: up and down move through them,
 * Enter follows one, Escape or a click outside closes the panel, and Tab stays
 * inside it. An index that cannot be fetched says so and is asked for again
 * the next time the search opens.
 */

import MiniSearch from "minisearch";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { type Close, SearchUnavailable } from "./components/search.js";
import { SEARCH_OPTIONS, type SearchHit } from "./search-options.js";

let index: Promise<MiniSearch> | undefined;

const loadIndex = (): Promise<MiniSearch> => {
  index ??= fetch(`${import.meta.env.BASE_URL}search-index.json`)
    .then((answer) => {
      if (!answer.ok) throw new Error(`the search index answered ${answer.status}`);
      return answer.text();
    })
    .then((json) => MiniSearch.loadJSON(json, SEARCH_OPTIONS))
    .catch((failure: unknown) => {
      index = undefined;
      throw failure;
    });
  return index;
};

/** Where the last query is kept; a browser that keeps nothing simply forgets it. */
const KEPT = "agentify-docs-search";

const keptQuery = (): string => {
  try {
    return localStorage.getItem(KEPT) ?? "";
  } catch {
    return "";
  }
};

const keepQuery = (query: string): void => {
  try {
    localStorage.setItem(KEPT, query);
  } catch {
    // Nothing kept is a search that opens empty.
  }
};

/** A result's address inside the documentation: `/docs/money#x` is `/money#x`. */
const inside = (id: string): string => id.replace(/^\/docs/, "") || "/";

const AROUND = 80;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The words around the first matched term of `text`, cut at word boundaries,
 * with every matched term in it marked.
 */
export function excerptOf(text: string, terms: readonly string[]): ReactNode[] {
  const wanted = terms.filter((term) => term.length > 0);
  if (wanted.length === 0) return [text.slice(0, AROUND * 2)];
  const pattern = new RegExp(`(${wanted.map(escapeRegExp).join("|")})`, "gi");
  const first = text.search(pattern);
  const from = first <= AROUND ? 0 : text.lastIndexOf(" ", first - AROUND) + 1;
  const to = Math.min(text.length, Math.max(first, 0) + AROUND);
  const end =
    to === text.length ? to : text.indexOf(" ", to) === -1 ? text.length : text.indexOf(" ", to);
  const window = `${from > 0 ? "… " : ""}${text.slice(from, end)}${end < text.length ? " …" : ""}`;
  return window.split(pattern).map((part, at) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one excerpt never move, so a part's place is its identity
    at % 2 === 1 ? <mark key={at}>{part}</mark> : part,
  );
}

export default function SearchPanel({ onClose }: Close) {
  const [query, setQuery] = useState(keptQuery);
  const [loaded, setLoaded] = useState<MiniSearch | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let current = true;
    loadIndex().then(
      (ready) => {
        if (current) setLoaded(ready);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, []);

  const results = useMemo(
    () =>
      loaded === null || query.trim() === ""
        ? []
        : (loaded.search(query).slice(0, 12) as unknown as SearchHit[]),
    [loaded, query],
  );

  if (failed) return <SearchUnavailable onClose={onClose} />;

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") setActive((at) => Math.min(at + 1, results.length - 1));
    else if (event.key === "ArrowUp") setActive((at) => Math.max(at - 1, 0));
    else if (event.key === "Enter" && results[active] !== undefined) {
      onClose(false);
      navigate(inside(results[active].id));
    } else return;
    event.preventDefault();
  };

  /** Escape closes the panel from wherever the focus is in it, and Tab goes round inside it. */
  const onPanelKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose(true);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(panel.current?.querySelectorAll<HTMLElement>("input, a[href], button") ?? []),
    ].filter((element) => element.tabIndex >= 0);
    const at = focusable.indexOf(document.activeElement as HTMLElement);
    const next = focusable.at(
      event.shiftKey ? (at <= 0 ? -1 : at - 1) : (at + 1) % focusable.length,
    );
    event.preventDefault();
    next?.focus();
  };

  return (
    <div className="search-backdrop" onClick={() => onClose(true)}>
      <div
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search the documentation"
        ref={panel}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onPanelKey}
      >
        <input
          autoFocus
          type="search"
          role="combobox"
          aria-label="Search the documentation"
          aria-autocomplete="list"
          aria-controls="search-results"
          aria-expanded={results.length > 0}
          aria-activedescendant={
            results[active] === undefined ? undefined : `search-result-${active}`
          }
          placeholder="Search the documentation"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            keepQuery(event.target.value);
            setActive(0);
          }}
          onFocus={(event) => event.target.select()}
          onKeyDown={onInputKey}
        />
        <ul className="search-results" id="search-results" role="listbox" aria-label="Results">
          {results.map((hit, at) => (
            <li key={hit.id} id={`search-result-${at}`} role="option" aria-selected={at === active}>
              <Link to={inside(hit.id)} onClick={() => onClose(false)} tabIndex={-1}>
                {hit.titles.length > 0 ? (
                  <span className="search-path">{hit.titles.join(" › ")}</span>
                ) : null}
                <span className="search-title">{hit.title}</span>
                <span className="search-excerpt">{excerptOf(hit.text, hit.terms)}</span>
              </Link>
            </li>
          ))}
        </ul>
        {loaded !== null && query.trim() !== "" && results.length === 0 ? (
          <p className="search-none">Nothing in the documentation matches “{query}”.</p>
        ) : null}
        {loaded === null ? <p className="search-none">Loading the index…</p> : null}
      </div>
    </div>
  );
}
