/**
 * Every page is answered whole: nothing on these pages waits behind a
 * suspense boundary, and a whole answer is the one whose status is final and
 * whose words a browser without script reads.
 */

import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { renderToPipeableStream } from "react-dom/server";
import { type EntryContext, ServerRouter } from "react-router";

export { refused, services } from "./services.js";

/** How long a page may take to draw before it is abandoned. */
export const streamTimeout = 10_000;

export default function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
): Promise<Response> {
  if (request.method === "HEAD") {
    return Promise.resolve(new Response(null, { status, headers }));
  }
  return new Promise((resolve, reject) => {
    let failed = false;
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
          resolve(
            new Response(createReadableStreamFromReadable(body), {
              headers,
              status: failed ? 500 : status,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          clearTimeout(timer);
          reject(error);
        },
        onError() {
          failed = true;
          console.error("[dashboard] a page failed to draw");
        },
      },
    );
  });
}

/**
 * A failure is logged as a line and nothing more: an exception from the
 * database or a provider can carry bound values, session tokens and keys, and
 * a log goes places the database does not.
 */
export function handleError(_error: unknown, { request }: { readonly request: Request }): void {
  if (!request.signal.aborted) {
    console.error("[dashboard] a request failed");
  }
}
