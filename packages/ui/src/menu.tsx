/**
 * The menu at the end of the site header's row where the page is too narrow
 * for the header's links: a button that opens a panel under the bar.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { useLocation } from "react-router";

/**
 * A details element, so it opens and closes before the page's script runs and
 * what it holds is out of the tab order while it is closed. Once the script
 * runs, Escape closes it wherever the focus is and hands the focus back to its
 * button, which a details element does not do on its own. It is drawn anew,
 * closed, on every move to a page, the same page included, since such a move
 * leaves the header where it was.
 */
export function HeaderMenu({ children }: Readonly<{ children: ReactNode }>) {
  return <Menu key={useLocation().key}>{children}</Menu>;
}

function Menu({ children }: Readonly<{ children: ReactNode }>) {
  const menu = useRef<HTMLDetailsElement>(null);

  // Heard from the start rather than once the menu says it opened, since a
  // browser tells that a moment after the press, and Escape can come first.
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      const details = menu.current;
      if (event.key !== "Escape" || details === null || !details.open) return;
      details.open = false;
      details.querySelector("summary")?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, []);

  // The panel reaches from where it opens to the foot of the window, and only
  // the drawn page knows where it opens: under the sticky header, at the
  // header's foot; under a page's own top, wherever that top ends. It is
  // measured as the menu opens, before the panel is first painted, which the
  // details element's own toggle event comes too late for.
  useEffect(() => {
    const details = menu.current;
    if (details === null) return;
    const fitToRoom = () => {
      const panel = details.lastElementChild;
      if (!details.open || panel === null) return;
      details.style.setProperty("--site-menu-top", `${panel.getBoundingClientRect().top}px`);
    };
    fitToRoom();
    const opening = new MutationObserver(fitToRoom);
    opening.observe(details, { attributeFilter: ["open"] });
    window.addEventListener("resize", fitToRoom);
    return () => {
      opening.disconnect();
      window.removeEventListener("resize", fitToRoom);
    };
  }, []);

  return (
    <details className="site-menu" ref={menu}>
      <summary aria-label="Menu">
        <span />
        <span />
        <span />
      </summary>
      <div className="site-menu-panel">{children}</div>
    </details>
  );
}
