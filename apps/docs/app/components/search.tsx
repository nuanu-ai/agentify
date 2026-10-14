import { lazy, Suspense, useEffect } from "react";

/** The panel and the index it searches are fetched the first time a reader opens the search. */
const SearchPanel = lazy(() => import("../search-panel.js"));

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
}: Readonly<{ open: boolean; onOpen: () => void; onClose: () => void }>) {
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
