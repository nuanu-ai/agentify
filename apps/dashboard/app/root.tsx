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
  isRouteErrorResponse,
  Links,
  type LoaderFunctionArgs,
  Meta,
  type MiddlewareFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useMatches,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import { inViewersZone } from "../src/moments.js";
import type { Screen } from "../src/page-services.js";
import { type Chrome, chromeOf, saidAsAsked, type Trouble, troubleIn } from "./answer.js";
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

/**
 * The page was drawn on the server in the zone the browser named before, or
 * in UTC where it named none; the browser names its zone now for the next
 * page, rather than this one being written again after it is shown.
 */
export default function App() {
  useEffect(rememberZone, []);
  return <Outlet />;
}

/**
 * The screen a press was made on, read off the address it posted to, which
 * is that screen's or one under it, and named as the sidebar names it; the
 * dashboard's start for anything else, which leads wherever the person
 * begins.
 */
const PRESSED_ON: Readonly<Record<string, readonly [string, string]>> = {
  products: ["/products", "Products"],
  orders: ["/orders", "Orders"],
  receipts: ["/receipts", "Receipts"],
  integrations: ["/integrations", "Integrations"],
  woocommerce: ["/woocommerce", "WooCommerce"],
  keys: ["/keys", "API keys"],
  settings: ["/settings", "Settings"],
  admin: ["/admin", "Admin"],
};

const screenOf = (path: string): readonly [string, string] =>
  PRESSED_ON[path.split(/[?#]/)[0]?.split("/")[1] ?? ""] ?? ["/", "the dashboard"];

/** One message panel: whether anything changed, why, and the one way on. */
function MessagePage({
  chrome,
  title,
  said,
  way,
}: Readonly<{ chrome: Chrome; title: string; said: ReactNode; way: readonly [string, string] }>) {
  return (
    <GatePage chrome={chrome} title={title}>
      <div className="message-panel">
        <h1>{title}</h1>
        <p>{said}</p>
        <a className="button button-primary" href={way[0]}>
          {way[1]}
        </a>
      </div>
    </GatePage>
  );
}

/**
 * The chrome comes with the trouble wherever the page's own loaders did not
 * run. The heading answers whether anything changed: a read changed nothing
 * and is offered again; a press refused changed nothing; a press that broke or
 * went unanswered may have been done, so the page sends the person to the
 * screen they pressed on to look before they press again, never to reload
 * an answer to a form, which would send the press a second time.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const root = useRouteLoaderData<typeof loader>("root");
  const { pathname } = useLocation();
  const trouble = troubleIn(error);
  const chrome = trouble?.chrome ?? root;
  if (chrome === undefined) {
    return <p>Something in the dashboard is broken.</p>;
  }
  if (trouble?.kind === "no-such-page") {
    return <NoSuchPage drawn={{ ...trouble.drawn, chrome }} />;
  }
  const [path, name] = screenOf(pathname);
  const open = [`${chrome.base}${path}`, `Open ${name}`] as const;
  if (trouble?.kind === "not-drawn-for-you") {
    // The gate's start is Products for somebody who sells, and the scanner's
    // latest report for somebody who does not, whom no screen here is for.
    const way =
      trouble.start === `${chrome.base}/products`
        ? open
        : ([trouble.start, "Open your latest report"] as const);
    return (
      <MessagePage
        chrome={chrome}
        title="Nothing was changed"
        said={
          <>
            You are signed in as <strong>{trouble.who}</strong>, and the page you pressed was not
            opened for this sign-in. Open it again to make the change.
          </>
        }
        way={way}
      />
    );
  }
  const again =
    trouble?.kind === "problem" || trouble?.kind === "unread" ? trouble.again : undefined;
  if (again !== undefined) {
    // A refusal is offered again only where it was a fault that may pass.
    const passing =
      trouble?.kind === "unread" || (isRouteErrorResponse(error) && error.status >= 500);
    return (
      <MessagePage
        chrome={chrome}
        title="This page could not be loaded"
        said={
          trouble?.kind === "problem"
            ? trouble.said
            : trouble?.kind === "unread" && trouble.answered === true
              ? "Your change was made, but the page could not be loaded after it."
              : "Loading it again changes nothing."
        }
        way={passing ? [again, "Try again"] : open}
      />
    );
  }
  // A press leads back to the page it was made on, its place in a list kept.
  const reopen =
    trouble?.kind === "problem" || trouble?.kind === "unanswered" || trouble?.kind === "broken"
      ? trouble.reopen
      : undefined;
  const back =
    reopen === undefined
      ? open
      : ([reopen, `Open ${screenOf(reopen.slice(chrome.base.length))[1]}`] as const);
  // A refused press did nothing where the server half says so, or where a
  // refusal came before any work; a fault nobody worded may have done it.
  if (
    trouble?.kind === "problem" &&
    (trouble.outcome === "refused" ||
      (trouble.outcome === undefined && isRouteErrorResponse(error) && error.status < 500))
  ) {
    return (
      <MessagePage chrome={chrome} title="Nothing was changed" said={trouble.said} way={back} />
    );
  }
  if (trouble?.kind === "broken") {
    return (
      <MessagePage
        chrome={chrome}
        title="Nothing was changed"
        said="Something broke on our side before anything was done. Try again in a moment."
        way={back}
      />
    );
  }
  if (trouble === undefined) {
    return (
      <MessagePage
        chrome={chrome}
        title="This page could not be shown"
        said={`Something broke on our side. If you pressed a button, check ${name} before you try again.`}
        way={open}
      />
    );
  }
  return (
    <MessagePage
      chrome={chrome}
      title="We don't know if this was done"
      said={`${trouble.kind === "problem" ? `${trouble.said} ` : ""}Something went wrong before we could confirm it. ${back[1]} to see where it stands; this sends nothing again.`}
      way={back}
    />
  );
}
