import { lazy, Suspense, useEffect } from "react";

/** `onClose(true)` when the reader closes the panel, so the focus goes back where it was; `onClose(false)` when they follow a result. */
export type Close = Readonly<{ onClose: (restoreFocus: boolean) => void }>;

/**
 * What the panel says when the search's code or its index could not be
 * fetched, as after a release has replaced the files this page was built with.
 */
export function SearchUnavailable({ onClose }: Close) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: clicking outside is a pointer shortcut; Escape inside the dialog closes it from the keyboard
    <div className="search-backdrop" role="presentation" onClick={() => onClose(true)}>
      <div
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Search the documentation"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose(true);
        }}
      >
        <p className="search-none" role="status">
          The search could not be loaded, perhaps because the documentation changed since this page
          was opened. Reload the page to search it.
        </p>
        <button
          // biome-ignore lint/a11y/noAutofocus: the reader opened this dialog, so its only action takes focus
          autoFocus
          type="button"
          className="button button-secondary search-reload"
          onClick={() => window.location.reload()}
        >
          Reload the page
        </button>
      </div>
    </div>
  );
}

/** The panel and the index it searches are fetched the first time a reader opens the search. */
const SearchPanel = lazy(() =>
  import("../search-panel.js").catch(() => ({ default: SearchUnavailable })),
);

/** The search's button, which the column and the phone's bar each draw. */
export function SearchButton({ onOpen }: Readonly<{ onOpen: () => void }>) {
  return (
    <button type="button" className="docs-search-button" onClick={onOpen}>
      Search
      <kbd>/</kbd>
    </button>
  );
}

/** The search's panel while it is open, opened also by "/" or Ctrl+K anywhere on the page. */
export function Search({
  open,
  onOpen,
  onClose,
}: Readonly<{ open: boolean; onOpen: () => void }> & Close) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && event.target.closest("input, textarea");
      if (
        (event.key === "k" && (event.metaKey || event.ctrlKey)) ||
        (event.key === "/" && !typing)
      ) {
        event.preventDefault();
        onOpen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onOpen]);
  return open ? (
    <Suspense fallback={null}>
      <SearchPanel onClose={onClose} />
    </Suspense>
  ) : null;
}
