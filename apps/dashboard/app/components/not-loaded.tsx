import type { ReactNode } from "react";
import { isRouteErrorResponse, useHref, useLocation, useRouteError } from "react-router";
import { troubleIn } from "../answer.js";
import { ErrorBoundary as PageTrouble } from "../root.js";
import { Frame, type Tab } from "./frame.js";

/**
 * A list that could not be read, said where it would stand, with the way to
 * read it again where reading it again could help.
 */
export const NotLoaded = ({
  again,
  children,
}: Readonly<{ again?: string; children: ReactNode }>) => (
  <div className="not-loaded">
    <div className="callout" role="alert">
      {children}
    </div>
    {again === undefined ? null : (
      <a className="button button-primary" href={again}>
        Try again
      </a>
    )}
  </div>
);

/**
 * The error page of a screen in the merchant's frame, for what the screen's
 * own loader or drawing failed with. A read that failed changed nothing, so it
 * is said in the frame, the sections beside it, with the same address offered
 * again; so is a page that failed to draw for a reason nobody named. A refusal
 * is said in its own words, and offered again only where it was a fault that
 * may pass. A failure the frame's own reads share, as when the connection
 * drops on the way to another section, and a press that failed, are the
 * dashboard's own page.
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
    const error = useRouteError();
    const trouble = troubleIn(error);
    const location = useLocation();
    const here = useHref(`${location.pathname}${location.search}`);
    if (trouble?.kind === "problem" && trouble.again !== undefined) {
      const passing = isRouteErrorResponse(error) && error.status >= 500;
      return (
        <Frame tab={tab} title={title}>
          <NotLoaded {...(passing ? { again: trouble.again } : {})}>
            <div className="what">{trouble.said}</div>
          </NotLoaded>
        </Frame>
      );
    }
    const again =
      trouble === undefined ? here : trouble.kind === "unread" ? trouble.again : undefined;
    if (again === undefined) return <PageTrouble />;
    return (
      <Frame tab={tab} title={title}>
        <NotLoaded again={again}>
          <div className="what">{`Your ${what} could not be loaded.`}</div>
          {trouble?.kind === "unread" && trouble.answered === true ? (
            <p className="why">Your change was made before this failed.</p>
          ) : null}
        </NotLoaded>
      </Frame>
    );
  };
