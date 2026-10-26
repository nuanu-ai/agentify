import type { ReactNode } from "react";
import { useHref, useLocation, useRouteError } from "react-router";
import { troubleIn } from "../answer.js";
import { ErrorBoundary as PageTrouble } from "../root.js";
import { Frame, type Tab } from "./frame.js";

/** A list that could not be read, said where it would stand, with the way to read it again. */
export const NotLoaded = ({
  again,
  children,
}: Readonly<{ again: string; children: ReactNode }>) => (
  <div className="not-loaded">
    <div className="callout" role="alert">
      {children}
    </div>
    <a className="button button-primary" href={again}>
      Try again
    </a>
  </div>
);

/**
 * The error page of a screen in the merchant's frame. A read that failed
 * changed nothing, so it is said in the frame, the sections beside it, with
 * the same address offered again; so is a page that failed to draw for a
 * reason nobody named. A press that failed may have been done, and is the
 * dashboard's own page about that.
 */
export const readFailedIn = ({
  tab,
  title,
  what,
}: Readonly<{
  tab: Tab;
  title: string;
  /** What the screen lists, as "Your … could not be loaded" names it: "orders". */
  what: string;
}>) =>
  function ReadFailed() {
    const trouble = troubleIn(useRouteError());
    const location = useLocation();
    const here = useHref(`${location.pathname}${location.search}`);
    const again =
      trouble === undefined
        ? here
        : trouble.kind === "unread" || trouble.kind === "problem"
          ? trouble.again
          : undefined;
    if (again === undefined) return <PageTrouble />;
    return (
      <Frame tab={tab} title={title}>
        <NotLoaded again={again}>
          <div className="what">{`Your ${what} could not be loaded.`}</div>
          <p className="why">Loading them changed nothing.</p>
        </NotLoaded>
      </Frame>
    );
  };
