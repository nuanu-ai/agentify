/**
 * The document every page is drawn in, and the page drawn when one cannot be.
 *
 * A route whose `handle` says `{ script: false }` is sent with no script at
 * all, not even React Router's own: the page a mailed link lands on holds a
 * one-time token, and a page may run a script only where a control needs one.
 */

import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Links,
  type LoaderFunctionArgs,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import { type Chrome, chromeOf, type Trouble } from "./answer.js";
import { GatePage } from "./components/gate-page.js";
import stylesheet from "./styles.css?url";

export const links = () => [
  { rel: "icon", href: "/assets/agentify-mark-heavy.svg", type: "image/svg+xml" },
  // Served beside the dashboard on the shared origin; run on its own the
  // dashboard has none, and the fallback stack in the tokens carries the page.
  { rel: "stylesheet", href: "/styles/fonts.css" },
  { rel: "stylesheet", href: stylesheet },
];

export const loader = ({ context }: LoaderFunctionArgs): Chrome => chromeOf(context);

/** Which stack this is does not change while the process runs. */
export const shouldRevalidate = () => false;

export function Layout({ children }: Readonly<{ children: ReactNode }>) {
  const scripted = !useMatches().some(
    (match) => (match.handle as { script?: boolean } | undefined)?.script === false,
  );
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        {scripted ? (
          <>
            <ScrollRestoration />
            <Scripts />
          </>
        ) : null}
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/** The chrome comes with the trouble wherever the page's own loaders did not run. */
export function ErrorBoundary() {
  const error = useRouteError();
  const root = useRouteLoaderData<typeof loader>("root");
  const trouble = isRouteErrorResponse(error) ? (error.data as Trouble | undefined) : undefined;
  const chrome = trouble?.chrome ?? root;
  if (chrome === undefined) {
    return <p>Something in the dashboard is broken.</p>;
  }
  if (trouble?.kind === "not-drawn-for-you") {
    return (
      <GatePage chrome={chrome} title="Nothing was changed">
        <div className="gate-card">
          <h1>Nothing was changed</h1>
          <p>
            What you pressed was not done, because the page it came from could not be matched to the
            address signed in on this browser now, <strong>{trouble.who}</strong>. Open the screen
            again to make the change as this address.
          </p>
          <a className="button button-primary" href={trouble.start}>
            Continue
          </a>
        </div>
      </GatePage>
    );
  }
  // A page that failed to draw is tried again at its own address, so the
  // merchant keeps their place; a form that failed cannot be sent again from
  // here, so its way on is the dashboard's first screen, named as that.
  const again = trouble?.kind === "problem" ? trouble.again : undefined;
  return (
    <GatePage chrome={chrome} title="Something went wrong">
      <div className="gate-card">
        <h1>Something went wrong</h1>
        <p>
          {trouble?.kind === "problem"
            ? trouble.said
            : "Something in the dashboard is broken. Check the page you were on before deciding whether it went through."}
        </p>
        {again === undefined ? (
          <a className="button button-primary" href={`${chrome.base}/cards`}>
            Back to Cards
          </a>
        ) : (
          <a className="button button-primary" href={again}>
            Try again
          </a>
        )}
      </div>
    </GatePage>
  );
}
