/**
 * How a page turns what its server half answered into what React Router
 * sends. Every loader and action passes its `Outcome` through `answer`, so a
 * redirect, a problem page and the headers a view carries are written the same
 * way everywhere.
 */

import {
  type DataStrategyResult,
  data,
  type HeadersFunction,
  isRouteErrorResponse,
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

/**
 * What a page that could not be drawn is drawn from instead. `again` is the
 * address a failed read offers once more. `reopen` is the page a press was
 * made on, or the address it was sent to, which a read leads to that page
 * from; reading it sends nothing again. A failure the browser met on the way
 * to the dashboard carries no chrome: the root's is already loaded there.
 */
export type Trouble =
  | Readonly<{ kind: "problem"; chrome: Chrome; said: string; again?: string; reopen?: string }>
  /**
   * The dashboard's page for an address it does not have, drawn where no
   * loader ran, with what the gate and the merchant's pages' layout read.
   */
  | Readonly<{ kind: "no-such-page"; chrome: Chrome; drawn: DrawnFor }>
  /**
   * A read that failed: it changed nothing. `answered` where it was the read
   * of the page after a press that was answered as done.
   */
  | Readonly<{ kind: "unread"; chrome?: Chrome; again: string; answered?: true }>
  /** A press whose answer never came: it may or may not have been done. */
  | Readonly<{ kind: "unanswered"; chrome?: Chrome; reopen: string }>
  /** A press the gate could not check, refused before anything below it ran. */
  | Readonly<{ kind: "broken"; chrome: Chrome; reopen: string }>
  | Readonly<{ kind: "not-drawn-for-you"; chrome: Chrome; who: string; start: string }>;

const KINDS: ReadonlySet<string> = new Set<Trouble["kind"]>([
  "problem",
  "no-such-page",
  "unread",
  "unanswered",
  "broken",
  "not-drawn-for-you",
]);

/** The trouble an error carries, where it is one the dashboard made. */
export const troubleIn = (error: unknown): Trouble | undefined => {
  if (!isRouteErrorResponse(error)) return undefined;
  const carried: unknown = error.data;
  return typeof carried === "object" &&
    carried !== null &&
    "kind" in carried &&
    typeof carried.kind === "string" &&
    KINDS.has(carried.kind)
    ? (carried as Trouble)
    : undefined;
};

/** Only GET and HEAD read; every other method may change something. */
const reads = (method: string): boolean => method === "GET" || method === "HEAD";

/**
 * A request that failed before it was answered, said by what it asked: a read
 * changed nothing and is offered again at its address, search and all; a press
 * may or may not have been done.
 */
export const failedAt = (method: string, url: URL, chrome?: Chrome): Trouble => {
  const at = `${url.pathname}${url.search}`;
  const drawn = chrome === undefined ? {} : { chrome };
  return reads(method)
    ? { kind: "unread", ...drawn, again: at }
    : { kind: "unanswered", ...drawn, reopen: at };
};

/** The same, for a request that failed before anything it asked for began. */
export const failedBefore = (method: string, url: URL, chrome: Chrome): Trouble =>
  reads(method)
    ? failedAt(method, url, chrome)
    : { kind: "broken", chrome, reopen: `${url.pathname}${url.search}` };

/** The status a press was answered with, where it was answered with data. */
const statusOf = (answered: unknown): number | undefined => {
  if (typeof answered !== "object" || answered === null || !("init" in answered)) return undefined;
  const { init } = answered as { init?: { status?: number } | null };
  return init?.status ?? 200;
};

/**
 * The address of a press answered as done. React Router reads the page after
 * a press at the press's own address, as the very next request, and that read
 * alone may say the change was made.
 */
let pressAnswered: string | null = null;

/**
 * The browser's half of the same rule, run around every request a page makes
 * once its script runs. A request that failed on its way, such as a dropped
 * connection, or came back as something the dashboard did not write, such as
 * a proxy's own 502 page while the process restarts, reaches the error page as
 * the read or the press it was. A press leads back to the page it was made
 * on, which is still the browser's address while the press is on its way,
 * with its place in a list. Nothing is sent again.
 */
export const saidAsAsked: MiddlewareFunction<Record<string, DataStrategyResult>> = async (
  { request },
  next,
) => {
  const after = pressAnswered === request.url;
  pressAnswered = null;
  const results = await next();
  if (request.signal.aborted) return results;
  const outcomes = Object.values(results);
  if (!reads(request.method)) {
    const done = outcomes.every(
      (result) => result.type === "data" && (statusOf(result.result) ?? 400) < 400,
    );
    if (done && outcomes.length > 0) pressAnswered = request.url;
  }
  const url = new URL(request.url);
  const at =
    reads(request.method) || typeof window === "undefined" ? url : new URL(window.location.href);
  for (const [route, result] of Object.entries(results)) {
    // A redirect arrives as a thrown response and is React Router's to follow.
    if (result.type !== "error" || result.result instanceof Response) continue;
    if (troubleIn(result.result) !== undefined) continue;
    const failed = failedAt(request.method, at);
    results[route] = {
      type: "error",
      result: data(failed.kind === "unread" && after ? { ...failed, answered: true } : failed),
    };
  }
  return results;
};

/** What the gate's loader reads for every page behind it. */
export interface Gated {
  readonly who: string;
  /**
   * The operator's workspace, the header's door into it, sent only for an
   * account that holds the operator flag: nobody else is told it exists.
   */
  readonly admin?: string;
}

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
 * one on a press offers a read of the press's address, never the press.
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
  // Nothing answered in time is not a refusal: a read of it changed nothing,
  // and a press of it may or may not have been done, whatever words came with it.
  if (outcome.problem.status === 504) {
    throw data(failedAt(request.method, url, chrome), {
      status: 504,
      headers: headersOf(undefined, outcome.setCookies),
    });
  }
  const trouble: Trouble = {
    kind: "problem",
    chrome,
    said: outcome.problem.said,
    ...(reads(request.method)
      ? { again: `${url.pathname}${url.search}` }
      : { reopen: `${url.pathname}${url.search}` }),
  };
  throw data(trouble, {
    status: outcome.problem.status,
    headers: headersOf(undefined, outcome.setCookies),
  });
}

/**
 * An action's server half, answered as `answer` answers it. A failure inside
 * it may have come after its work was done, so it is drawn as a press of
 * unknown outcome, with the chrome from here, because React Router runs no
 * loader after an action that throws, not even the root's. The exception is
 * not logged, for the reason the server entry gives.
 */
export async function acted<View>(run: () => Promise<Outcome<View>>, asked: Asked) {
  let outcome: Outcome<View>;
  try {
    outcome = await run();
  } catch (thrown) {
    console.error("[dashboard] a request failed");
    const { request, url, context } = asked;
    throw data(failedAt(request.method, url, chromeOf(context)), {
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
    throw data(failedAt("GET", url, chromeOf(context)), { status: 500 });
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
