/**
 * How a page turns what its server half answered into what React Router
 * sends. Every loader and action passes its `Outcome` through `answer`, so a
 * redirect, a problem page and the headers a view carries are written the same
 * way everywhere.
 */

import {
  data,
  type HeadersFunction,
  type MiddlewareFunction,
  type RouterContextProvider,
  redirect,
  redirectDocument,
  useRouteLoaderData,
} from "react-router";
import { cookiesCarriedBy } from "../src/carried-cookies.js";
import type { Outcome, Surface } from "../src/page-services.js";
import type { FrameView } from "../src/views.js";
import { services } from "./services.js";

/** What every page needs to be drawn, including one drawn for an error. */
export interface Chrome {
  /** "" when mounted at the root of its origin. */
  readonly base: string;
  readonly surface: Surface;
}

/** What a page that could not be drawn is drawn from instead. */
export type Trouble =
  | Readonly<{ kind: "problem"; chrome: Chrome; said: string; again?: string }>
  /**
   * The dashboard's page for an address it does not have, drawn where no
   * loader ran, with what the gate and the merchant's pages' layout read.
   */
  | Readonly<{ kind: "no-such-page"; chrome: Chrome; drawn: DrawnFor }>
  | Readonly<{ kind: "unread"; chrome: Chrome; again: string }>
  | Readonly<{ kind: "not-drawn-for-you"; chrome: Chrome; who: string; start: string }>
  | Readonly<{ kind: "broken"; chrome: Chrome }>;

/** What a page behind the gate is drawn with: the address signed in, and the merchant's pages' frame. */
export interface DrawnFor {
  readonly who: string;
  readonly framed: FrameView;
}

export const chromeOf = (context: Readonly<RouterContextProvider>): Chrome => {
  const pages = context.get(services);
  return { base: pages.base, surface: pages.surface };
};

/** The chrome the root loaded, which every page drawn without an error has. */
export const useChrome = (): Chrome => {
  const chrome = useRouteLoaderData<Chrome>("root");
  if (chrome === undefined) {
    throw new Error("a page was drawn without the root's chrome, which every page loads first");
  }
  return chrome;
};

const headersOf = (
  given: Readonly<Record<string, string>> | undefined,
  cookies: readonly string[] | undefined,
): Headers => {
  const headers = new Headers(given);
  for (const line of cookies ?? []) {
    headers.append("set-cookie", line);
  }
  return headers;
};

/**
 * Sends the browser to a path of this site. A redirect back to the page the
 * request was answered at stays inside the application whatever its query,
 * and a browser running the pages' script reads that page afresh, a list at
 * the search and the page the query names. Anywhere else the page loads
 * whole, since the path may be the scanner's, and a press that leads to
 * another page, a sign-out among them, starts it with nothing of the page
 * before it in memory. React Router reads a redirect from a loader or an
 * action as a path under its own prefix, so a path under the dashboard's is
 * handed over without it, and one outside it is written as a whole address on
 * the origin the request came to.
 *
 * A whole address on another site, such as the shop a Connect goes to, is
 * sent as a browser writes it: a header carries no letter outside Latin-1, so
 * a shop's name in another script would otherwise fail the answer after the
 * press had done its work.
 */
export function sendTo(location: string, url: URL, base: string, headers?: Headers): Response {
  const elsewhere = /^https?:\/\//i.test(location);
  const within = elsewhere
    ? new URL(location).href
    : base === ""
      ? location
      : location === base || location.startsWith(`${base}/`) || location.startsWith(`${base}?`)
        ? location.slice(base.length) || "/"
        : null;
  const init = { status: 303, ...(headers === undefined ? {} : { headers }) };
  const [path] = location.split(/[?#]/);
  return within !== null && path === url.pathname
    ? redirect(within, init)
    : redirectDocument(within ?? `//${url.host}${location}`, init);
}

/**
 * For a route that answers a press: a read of its own address, from history or
 * the address bar, leads to the page the press's form lives on, since a page
 * drawn there without a press would say nothing happened. The data a page
 * drawn there after a press asks for, at the same address with `.data` on the
 * end, goes through.
 */
export const readsLeadTo = (page: string): MiddlewareFunction<Response>[] => [
  ({ request, url, context }, next) => {
    const reading = request.method === "GET" || request.method === "HEAD";
    if (reading && new URL(request.url).pathname === url.pathname) {
      // Sent as it is, prefix and all, as the gate's redirects are.
      throw redirectDocument(`${context.get(services).base}${page}`, 303);
    }
    return next();
  },
];

/**
 * What a loader or an action is handed. `url` is the page's address with React
 * Router's own parts taken off (a data request's `.data` and `_routes`);
 * `request.url` is the address as it arrived.
 */
export interface Asked {
  readonly request: Request;
  readonly url: URL;
  readonly context: Readonly<RouterContextProvider>;
}

/**
 * The view to draw, under its status and headers; or a thrown redirect or
 * problem page. A problem on a page that failed to load offers the page again;
 * one on a form that failed cannot be sent again from there.
 */
export function answer<View>(outcome: Outcome<View>, { request, url, context }: Asked) {
  if (outcome.kind === "view") {
    return data(outcome.view, {
      status: outcome.status ?? 200,
      headers: headersOf(outcome.headers, outcome.setCookies),
    });
  }
  const chrome = chromeOf(context);
  if (outcome.kind === "redirect") {
    throw sendTo(
      outcome.location,
      url,
      chrome.base,
      headersOf(outcome.headers, outcome.setCookies),
    );
  }
  const trouble: Trouble = {
    kind: "problem",
    chrome,
    said: outcome.problem.said,
    ...(request.method === "GET" ? { again: `${url.pathname}${url.search}` } : {}),
  };
  throw data(trouble, {
    status: outcome.problem.status,
    headers: headersOf(undefined, outcome.setCookies),
  });
}

/**
 * An action's server half, answered as `answer` answers it. A failure inside
 * it is drawn as the dashboard's broken page from here, because React Router
 * runs no loader after an action that throws, not even the root's, and the
 * page it would draw has no chrome. The exception is not logged, for the
 * reason the server entry gives.
 */
export async function acted<View>(run: () => Promise<Outcome<View>>, asked: Asked) {
  let outcome: Outcome<View>;
  try {
    outcome = await run();
  } catch (thrown) {
    console.error("[dashboard] a request failed");
    throw data({ kind: "broken", chrome: chromeOf(asked.context) } satisfies Trouble, {
      status: 500,
      headers: headersOf(undefined, cookiesCarriedBy(thrown)),
    });
  }
  return answer(outcome, asked);
}

/**
 * A loader's server half that only reads, answered as `answer` answers it. A
 * failure inside it changed nothing, so the page drawn instead offers the
 * same address again. The exception is not logged, for the reason the server
 * entry gives.
 */
export async function readOnly<View>(run: () => Promise<Outcome<View>>, asked: Asked) {
  let outcome: Outcome<View>;
  try {
    outcome = await run();
  } catch {
    console.error("[dashboard] a request failed");
    const { url, context } = asked;
    throw data(
      {
        kind: "unread",
        chrome: chromeOf(context),
        again: `${url.pathname}${url.search}`,
      } satisfies Trouble,
      { status: 500 },
    );
  }
  return answer(outcome, asked);
}

/**
 * The form a request carried, or an empty one where the body is not a form: a
 * program can post anything, and what it sent amounts to a form with nothing
 * in it, never to a fault of the dashboard's.
 */
export async function formOf(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    return new FormData();
  }
}

/**
 * For a route whose answers carry headers of their own: React Router passes
 * only cookies on unless a route says which headers its page is sent with. An
 * action's headers win over the loader's that run after it.
 */
export const carried: HeadersFunction = ({ actionHeaders, loaderHeaders, errorHeaders }) => {
  const headers = new Headers(loaderHeaders);
  for (const [name, value] of actionHeaders) headers.set(name, value);
  for (const [name, value] of errorHeaders ?? []) headers.set(name, value);
  headers.delete("set-cookie");
  return headers;
};
