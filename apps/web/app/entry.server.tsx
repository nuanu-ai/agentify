/**
 * Every page is answered whole: it is sent once everything on it is drawn,
 * the parts whose script loads on its own included, and a whole answer is the
 * one whose status is final and whose words a browser without script reads.
 */

import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { renderToPipeableStream } from "react-dom/server";
import { type EntryContext, isRouteErrorResponse, ServerRouter } from "react-router";
import { pageOf, UNKEPT_PAGE_CACHE } from "../lib/server/answer-headers";
import { logUnhandledRequestError } from "../lib/server/http";

/** How long a page may take to draw before it is abandoned. */
export const streamTimeout = 10_000;

export default function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
): Promise<Response> {
  if (!headers.has("cache-control")) headers.set("cache-control", UNKEPT_PAGE_CACHE);
  // No page acts, so a 405 is a page refusing all but reads; a page given an
  // action takes posts as well, and this must then name them.
  if (status === 405) headers.set("allow", "GET, HEAD");
  if (request.method === "HEAD") {
    headers.set("content-type", "text/html; charset=utf-8");
    return Promise.resolve(new Response(null, { status, headers }));
  }
  return new Promise((resolve, reject) => {
    // A failure the page could still be drawn around is logged here once the
    // page is whole; one that stops the drawing reaches `handleError` instead.
    let failure: { error: unknown } | null = null;
    const timer = setTimeout(() => abort(), streamTimeout);
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={context} url={request.url} />,
      {
        onAllReady() {
          const body = new PassThrough({
            final(callback) {
              clearTimeout(timer);
              callback();
            },
          });
          headers.set("content-type", "text/html; charset=utf-8");
          if (failure !== null) logUnhandledRequestError(failure.error, describe(request));
          resolve(
            new Response(createReadableStreamFromReadable(body), {
              headers,
              status: failure === null ? status : 500,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          clearTimeout(timer);
          reject(error);
        },
        onError(error) {
          failure ??= { error };
        },
      },
    );
  });
}

/** A page's data, like the page, is kept by nobody unless its address says otherwise. */
export function handleDataRequest(response: Response): Response {
  if (!response.headers.has("cache-control")) {
    response.headers.set("cache-control", UNKEPT_PAGE_CACHE);
  }
  return response;
}

/**
 * A failed loader, action or route is one log line. A request the client gave
 * up on is none, and neither is one the router refused for the client's own
 * doing, such as a form posted to a page that takes none.
 */
export function handleError(error: unknown, { request }: { readonly request: Request }): void {
  if (request.signal.aborted || (isRouteErrorResponse(error) && error.status < 500)) return;
  logUnhandledRequestError(error, describe(request));
}

const describe = (request: Request) => ({
  method: request.method,
  path: pageOf(new URL(request.url).pathname).page,
  requestId: request.headers.get("x-request-id"),
});
