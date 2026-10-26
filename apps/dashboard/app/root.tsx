/**
 * The document every page is drawn in, and the page drawn when one cannot be.
 *
 * A route whose `handle` says `{ script: false }` is sent with no script at
 * all, not even React Router's own: the page a mailed link lands on holds a
 * one-time token, and a page may run a script only where a control needs one.
 */

import type { ReactNode } from "react";
import {
  data,
  isRouteErrorResponse,
  Links,
  type LoaderFunctionArgs,
  Meta,
  type MiddlewareFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import type { Screen } from "../src/page-services.js";
import { type Chrome, chromeOf, type Trouble } from "./answer.js";
import { GatePage } from "./components/gate-page.js";
import { NoSuchPage } from "./routes/no-such-page.js";
import { refused, services, signedInOrNobody, visit } from "./services.js";
import stylesheet from "./styles.css?url";

export const links = () => [
  { rel: "icon", href: "/assets/agentify-mark-heavy.svg", type: "image/svg+xml" },
  // Served beside the dashboard on the shared origin; run on its own the
  // dashboard has none, and the fallback stack in the tokens carries the page.
  { rel: "stylesheet", href: "/styles/fonts.css" },
  { rel: "stylesheet", href: stylesheet },
];

/** The screens product analytics counts a visit to, by the route that draws each. */
const SCREENS: Readonly<Record<string, Screen>> = {
  "sign-in": "sign_in",
  merchant: "merchant",
  "choose-name": "choose_name",
  cards: "cards",
  orders: "orders",
  receipts: "receipts",
  integrations: "integrations",
  settings: "settings",
  "settings/payout-wallet": "payout_wallet",
  keys: "keys",
  woocommerce: "woocommerce",
};

/**
 * A visit that was answered with a screen, its problem page among them, is
 * recorded once the answer is ready; one sent elsewhere showed nothing. A
 * press is not recorded here: what it came to is recorded by whatever decided
 * it, the identity, the gateway or the press's own server half.
 *
 * A post the process refused, from another site or longer than any form here,
 * is answered here, before any route below reads it, the gate included, which
 * reads the mark a form carries.
 */
export const middleware: MiddlewareFunction<Response>[] = [
  async ({ context, pattern, request }, next) => {
    const response = await next();
    const screen = SCREENS[pattern];
    const redirected = response.status >= 300 && response.status < 400;
    if (screen !== undefined && !redirected && context.get(visit)) {
      context
        .get(services)
        .shown(
          screen,
          signedInOrNobody(context),
          response.status,
          request.headers.get("user-agent"),
        );
    }
    return response;
  },
  ({ context }, next) => {
    const refusal = context.get(refused);
    if (refusal !== null) {
      throw data(
        { kind: "problem", chrome: chromeOf(context), said: refusal.said } satisfies Trouble,
        { status: refusal.status },
      );
    }
    return next();
  },
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
  if (trouble?.kind === "no-such-page") {
    return <NoSuchPage drawn={{ ...trouble.drawn, chrome }} />;
  }
  if (trouble?.kind === "not-drawn-for-you") {
    return (
      <GatePage chrome={chrome} title="Nothing was changed">
        <div className="message-panel">
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
      <div className="message-panel">
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
