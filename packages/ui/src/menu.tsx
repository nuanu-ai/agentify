/**
 * The two menus a header's row holds: the account's, a button with the
 * signed-in address that opens a small panel under it, and, where the page is
 * too narrow for the row's links, the menu whose button ends the row and opens
 * a panel across the whole bar.
 */

import { type FocusEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";
import { useLocation } from "react-router";

/**
 * Both are details elements, so they open and close before the page's script
 * runs and what they hold is out of the tab order while closed. Once the
 * script runs, Escape closes an open one wherever the focus is and hands the
 * focus back to its button, and the focus moving on to the page behind it
 * closes it, neither of which a details element does on its own. Each is drawn
 * anew, closed, on every move to a page, the same page included, since such a
 * move leaves the header where it was.
 */
function useClosedByEscape(menu: RefObject<HTMLDetailsElement | null>) {
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
  }, [menu]);
}

const closedOnLeaving = (event: FocusEvent<HTMLDetailsElement>) => {
  // The focus leaving the window, or landing on nothing, leaves it open.
  const next = event.relatedTarget;
  if (next instanceof Node && !event.currentTarget.contains(next)) {
    event.currentTarget.open = false;
  }
};

export function HeaderMenu({ children }: Readonly<{ children: ReactNode }>) {
  return <Menu key={useLocation().key}>{children}</Menu>;
}

function Menu({ children }: Readonly<{ children: ReactNode }>) {
  const menu = useRef<HTMLDetailsElement>(null);
  useClosedByEscape(menu);

  // The panel reaches from where it opens to the foot of the window, and only
  // the drawn page knows where that is: at the foot of the sticky header,
  // which a band above it can push down. It is measured as the menu opens,
  // before the panel is first painted, which the details element's own toggle
  // event comes too late for, and again as the window changes size. A menu
  // the bar has stopped showing, the window having grown too wide for it, is
  // closed rather than measured: left open, it would come back with the
  // window's scroll held and its button perhaps out of view.
  useEffect(() => {
    const details = menu.current;
    if (details === null) return;
    const fitOrClose = () => {
      const panel = details.lastElementChild;
      if (!details.open || panel === null) return;
      if (details.getClientRects().length === 0) {
        details.open = false;
        return;
      }
      details.style.setProperty("--site-menu-top", `${panel.getBoundingClientRect().top}px`);
    };
    fitOrClose();
    const opening = new MutationObserver(fitOrClose);
    opening.observe(details, { attributeFilter: ["open"] });
    window.addEventListener("resize", fitOrClose);
    return () => {
      opening.disconnect();
      window.removeEventListener("resize", fitOrClose);
    };
  }, []);

  return (
    <details className="site-menu" ref={menu} onBlur={closedOnLeaving}>
      <summary aria-label="Menu">
        <span />
        <span />
        <span />
      </summary>
      <div className="site-menu-panel">{children}</div>
    </details>
  );
}

/** `who` is the signed-in address the button shows, cut short where it is long; the panel holds `children`. */
export function AccountMenu({ who, children }: Readonly<{ who: string; children: ReactNode }>) {
  return (
    <Account key={useLocation().key} who={who}>
      {children}
    </Account>
  );
}

function Account({ who, children }: Readonly<{ who: string; children: ReactNode }>) {
  const menu = useRef<HTMLDetailsElement>(null);
  useClosedByEscape(menu);
  return (
    <details className="site-account" ref={menu} onBlur={closedOnLeaving}>
      <summary title={who}>
        <span className="site-who">{who}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </summary>
      <div className="site-account-panel">{children}</div>
    </details>
  );
}
