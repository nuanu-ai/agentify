/**
 * What the scanner adds to an answer by its address, whatever route drew it.
 *
 * Every answer carries the security headers. A scan and a report are kept by
 * nobody, leak no address in a referrer and are indexed by no crawler. The
 * public pages may be kept by a shared cache for an hour and are offered as
 * Markdown to a client that prefers it; their data may be kept by the browser
 * for a moment, so the click after a hover is answered by the hover's fetch.
 * A prefetch of a public page itself is answered as a page, never as Markdown
 * and never as a public answer.
 */

import { PUBLIC_PAGE_PATHS, type PublicPagePath } from "../../content/public-page-metadata";
import { appendVary, isPrefetch, prefersMarkdown } from "../accept-negotiation";
import { getPublicPageMarkdown } from "../public-markdown";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const PRIVATE_PLACES: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
  [
    "/scan",
    {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    },
  ],
  [
    "/report",
    {
      "Cache-Control": "private, no-store",
      // The report's own forms post back to this origin, which a browser
      // marks with `Origin: null` under `no-referrer`.
      "Referrer-Policy": "strict-origin",
      "X-Robots-Tag": "noindex, nofollow",
    },
  ],
];

const PUBLIC_PAGE = {
  "Cache-Control": "public, max-age=0, s-maxage=3600",
  "Content-Language": "en-US",
};

const PUBLIC_DATA_CACHE = "public, max-age=10";

/** What a page carries when its route says nothing of caching: nobody keeps it. */
export const UNKEPT_PAGE_CACHE = "private, no-cache, no-store, max-age=0, must-revalidate";

/**
 * The page a request is about, and whether it asks for the page's data rather
 * than the page: React Router asks for `/methodology` as `/methodology.data`,
 * and for `/` as `/_.data`.
 */
export function pageOf(pathname: string): Readonly<{ page: string; data: boolean }> {
  if (pathname.endsWith("/_.data"))
    return { page: pathname.slice(0, -"_.data".length), data: true };
  if (pathname.endsWith(".data")) return { page: pathname.slice(0, -".data".length), data: true };
  return { page: pathname, data: false };
}

const isPublicPage = (page: string): page is PublicPagePath =>
  (PUBLIC_PAGE_PATHS as readonly string[]).includes(page);

const reads = (request: Request): boolean => request.method === "GET" || request.method === "HEAD";

/**
 * The Markdown variant of a public page, for a visit whose `Accept` prefers it
 * to HTML; null for any other request, which goes on to the page. A `HEAD` is
 * answered with the headers alone by the router, as every answer is.
 */
export function markdownAnswer(request: Request): Response | null {
  const { page, data } = pageOf(new URL(request.url).pathname);
  if (data || !reads(request) || !isPublicPage(page) || isPrefetch(request.headers)) return null;
  if (!prefersMarkdown(request.headers.get("accept"))) return null;
  return new Response(getPublicPageMarkdown(page), {
    status: 200,
    headers: {
      ...PUBLIC_PAGE,
      Vary: "Accept",
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

/** `response` with the headers its address calls for, over whatever its route set. */
export function withPlaceHeaders(request: Request, response: Response): Response {
  const { page, data } = pageOf(new URL(request.url).pathname);
  const set: Record<string, string> = {};
  for (const [place, headers] of PRIVATE_PLACES) {
    if (page === place || page.startsWith(`${place}/`)) Object.assign(set, headers);
  }
  const kept = response.ok && reads(request) && isPublicPage(page);
  if (kept && data) set["Cache-Control"] = PUBLIC_DATA_CACHE;
  if (kept && !data && !isPrefetch(request.headers)) {
    Object.assign(set, PUBLIC_PAGE);
    set.Vary = appendVary(response.headers.get("vary"), "Accept");
  }
  if (Object.keys(set).length === 0) return response;
  const answered = new Response(response.body, response);
  for (const [name, value] of Object.entries(set)) answered.headers.set(name, value);
  return answered;
}
