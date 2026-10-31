/**
 * The document every page is drawn in, and the page drawn when one cannot be.
 *
 * A route whose `handle` says `{ script: false }` is sent with no script at
 * all, not even React Router's own: the page a mailed link lands on holds a
 * one-time token, and a page may run a script only where a control needs one.
 */

import { rememberZone } from "@agentify/ui/remember-zone";
import { zoneIn } from "@agentify/ui/zone";
import { type ReactNode, useEffect } from "react";
import {
  type DataStrategyResult,
  data,
  Links,
  type LoaderFunctionArgs,
  type MiddlewareFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
  useMatches,
} from "react-router";
import { inViewersZone } from "../src/moments.js";
import type { Screen } from "../src/page-services.js";
import { type Chrome, chromeOf, saidAsAsked, type Trouble } from "./answer.js";
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
  products: "cards",
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
  // Every moment a page writes is in the zone the reader's browser named.
  ({ request }, next) => inViewersZone(zoneIn(request.headers.get("cookie")), next),
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

export const clientMiddleware: MiddlewareFunction<Record<string, DataStrategyResult>>[] = [
  saidAsAsked,
];

export const loader = ({ context }: LoaderFunctionArgs): Chrome => chromeOf(context);

/** Which stack this is does not change while the process runs. */
export const shouldRevalidate = () => false;

export function Layout({ children }: Readonly<{ children: ReactNode }>) {
  const matches = useMatches();
  const script = matches
    .map((match) => (match.handle as { script?: boolean | string } | undefined)?.script)
    .filter((value) => value !== undefined)
    .at(-1);
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {matches.some((match) => match.id === "routes/sign-in") ? (
          <meta name="robots" content="noindex" />
        ) : null}
        <Links />
      </head>
      <body>
        {children}
        {typeof script === "string" ? (
          <script type="module" src={script} />
        ) : script !== false ? (
          <>
            <ScrollRestoration />
            <Scripts />
          </>
        ) : null}
      </body>
    </html>
  );
}

/**
 * The page was drawn on the server in the zone the browser named before, or
 * in UTC where it named none; the browser names its zone now for the next
 * page, rather than this one being written again after it is shown.
 */
export default function App() {
  useEffect(rememberZone, []);
  return <Outlet />;
}

export { ErrorBoundary } from "./error-boundary.js";
