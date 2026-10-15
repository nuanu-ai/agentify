import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Contents, type Section } from "./contents.js";
import { useSectionInView } from "./in-view.js";
import { Outline } from "./outline.js";
import { Search, SearchButton } from "./search.js";

/**
 * A page of the documentation in the editorial layout: beside the article,
 * the search and the contents, kept in view on a wide screen; on a phone,
 * where the contents are in the site header's menu, a bar under the header
 * with the search and the page's sections.
 */
export function Reading({
  current,
  sections,
  children,
}: Readonly<{ current: string | null; sections: readonly Section[]; children: ReactNode }>) {
  const [searching, setSearching] = useState(false);
  const opener = useRef<Element | null>(null);
  const open = useCallback(() => {
    opener.current = document.activeElement;
    setSearching(true);
  }, []);
  // Closed by the reader, the focus goes back to what opened the search.
  const close = useCallback((restoreFocus: boolean) => {
    setSearching(false);
    const back = opener.current;
    if (restoreFocus && back instanceof HTMLElement) requestAnimationFrame(() => back.focus());
  }, []);
  const ids = useMemo(() => sections.map((section) => section.id), [sections]);
  const inView = useSectionInView(ids);
  return (
    <main className="editorial docs container" id="main">
      <aside className="editorial-contents docs-aside">
        <SearchButton onOpen={open} />
        <Contents current={current} sections={sections} inView={inView} label="Documentation" />
      </aside>
      <article className="editorial-article docs-article">
        <div className="docs-bar">
          <SearchButton onOpen={open} />
          {sections.length > 0 ? <Outline sections={sections} inView={inView} /> : null}
        </div>
        {children}
      </article>
      <Search open={searching} onOpen={open} onClose={close} />
    </main>
  );
}
