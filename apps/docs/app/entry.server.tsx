/**
 * Draws a page whole for the prerender, which writes each page to a file:
 * there is nobody to stream to.
 */

import { renderToReadableStream } from "react-dom/server";
import { type EntryContext, ServerRouter } from "react-router";

export default async function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
): Promise<Response> {
  const body = await renderToReadableStream(<ServerRouter context={context} url={request.url} />, {
    signal: request.signal,
  });
  await body.allReady;
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { status, headers });
}
