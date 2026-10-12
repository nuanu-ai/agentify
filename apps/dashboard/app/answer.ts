/**
 * How a page turns what its server half answered into what React Router
 * sends. Every loader and action passes its `Outcome` through `answer`, so a
 * redirect, a problem page and the headers a view carries are written the same
 * way everywhere.
 */

import {
  data,
  type HeadersFunction,
  type RouterContextProvider,
  redirect,
  redirectDocument,
  useRouteLoaderData,
} from "react-router";
import type { Outcome, Surface } from "../src/page-services.js";
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
  | Readonly<{ kind: "not-drawn-for-you"; chrome: Chrome; who: string; start: string }>
  | Readonly<{ kind: "broken"; chrome: Chrome }>;

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
 * Sends the browser to a path of this site. Back to the page the request was
 * answered at, which this application draws, it stays inside the application,
 * and a browser running the pages' script reads the page afresh; anywhere else
 * it loads the page whole, since the path may be a page still drawn as a
 * string, or the scanner's. React Router reads a redirect from a loader or an
 * action as a path under its own prefix, so a path under the dashboard's is
 * handed over without it, and one outside it is written as a whole address on
 * the origin the request came to.
 */
export function sendTo(location: string, url: URL, base: string, headers?: Headers): Response {
  const within =
    base === ""
      ? location
      : location === base || location.startsWith(`${base}/`) || location.startsWith(`${base}?`)
        ? location.slice(base.length) || "/"
        : null;
  const init = { status: 303, ...(headers === undefined ? {} : { headers }) };
  return within !== null && location === url.pathname
    ? redirect(within, init)
    : redirectDocument(within ?? `//${url.host}${location}`, init);
}

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
  throw data(trouble, { status: outcome.problem.status });
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
