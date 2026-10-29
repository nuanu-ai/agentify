/**
 * The scanner's process: Express in front of React Router, which answers every
 * page and every API route (`app/routes.ts`). What stands in front of it is
 * short. Every answer carries the security headers; an address with a trailing
 * or a repeated slash is sent to the one without it; the browser's built files
 * are served with a year's cache and the files copied from `public/` as they
 * are; a request's body is read whole before any route sees it, and one over
 * 64 KiB is refused with 413.
 *
 * `trust proxy` stays off: what the scanner knows of a visitor's address it
 * reads from the `X-Forwarded-For` the edge writes, and Express would put a
 * value spoofable by any other peer behind `request.ip` and `request.secure`.
 *
 * This file is the server half of the build: `dist/server/index.js` is this
 * module with React Router's build and every package it imports inside it,
 * and `server.js` starts it.
 */

import { METHODS, type Server } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import * as build from "virtual:react-router/server-build";
import { classifyHttpRoute, listenForMetrics, telemetry } from "@agentify/observability";
import { precompressedFrom } from "@agentify/ui/assets";
import { createRequestHandler } from "@react-router/express";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { matchRoutes, type RouteObject, type ServerBuild } from "react-router";
import { pageOf, SECURITY_HEADERS, UNKEPT_PAGE_CACHE } from "../lib/server/answer-headers";
import { retryDueDataCopies } from "../lib/server/data-copy";
import { errorResponse, logBackgroundFailure, logUnhandledRequestError } from "../lib/server/http";
import { retryPendingScannerIdentityDeletions } from "../lib/server/scanner-identity-deletion";
import { startPrivacyRetries } from "./privacy-retries";

export { build };

export interface ScannerParts {
  /** Sends the built scripts, styles and fonts under `/assets`; absent where no browser asks. */
  readonly assets?: RequestHandler;
  /**
   * Sends what the build copied from `public/`, or in development Vite's
   * modules; it passes on what it does not have. Absent where no browser asks.
   */
  readonly files?: RequestHandler;
  /** Development shows a failing loader's error on the page; production never does. */
  readonly mode: "production" | "development";
}

/**
 * The build's routes as a tree that says of each whether it draws a page, for
 * asking about an address before React Router does. A route draws nothing,
 * and answers with data or a file, where it has neither a component nor an
 * error boundary of its own, as React Router decides.
 */
const routeTree = (built: Pick<ServerBuild, "routes">): RouteObject[] => {
  const childrenOf = (parentId: string | undefined): RouteObject[] =>
    Object.values(built.routes).flatMap((route): RouteObject[] => {
      if (route === undefined || route.parentId !== parentId) return [];
      const module = route.module as { default?: unknown; ErrorBoundary?: unknown };
      const shared = {
        id: route.id,
        caseSensitive: route.caseSensitive === true,
        handle: { draws: module.default !== undefined || module.ErrorBoundary !== undefined },
        ...(route.path === undefined ? {} : { path: route.path }),
      };
      return [
        route.index === true
          ? { ...shared, index: true }
          : { ...shared, children: childrenOf(route.id) },
      ];
    });
  return childrenOf(undefined);
};

const carried = (method: string): boolean => {
  try {
    new Request("http://scanner.invalid/", { method });
    return true;
  } catch {
    return false;
  }
};

/**
 * The methods Node lets through that a fetch `Request`, the form React Router
 * is handed a request in, refuses to carry. No address of the scanner's takes
 * them, and React Router would fail on them as the process's own error.
 */
const UNCARRIED = new Set(METHODS.filter((method) => !carried(method)));

const ROUTED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/** A request's path as React Router reads it, with `/./`, `/../` and `%2e` taken out. */
const routedPath = (request: Request): string =>
  new URL(request.originalUrl, "http://scanner.invalid").pathname;

const decodes = (path: string): boolean => {
  try {
    decodeURI(path);
    return true;
  } catch {
    return false;
  }
};

/** A short plain answer of the process's own, which nobody keeps. */
const plainly = (response: Response, status: number, words: string): void => {
  response.status(status).setHeader("cache-control", UNKEPT_PAGE_CACHE);
  response.type("text/plain").send(words);
};

/**
 * The most a request's body may carry. What the scanner's routes take is a few
 * fields of JSON, and a body is read whole before a route sees it.
 */
const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * A request's body read whole, or `null` once it runs past the limit, counted
 * as the bytes arrive, since a body sent in chunks states no length. A body
 * whose sender goes away before it ends is `undefined`.
 */
const boundedBody = (request: Request): Promise<Buffer | null | undefined> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const take = (chunk: Buffer) => {
      length += chunk.length;
      if (length <= BODY_LIMIT_BYTES) {
        chunks.push(chunk);
        return;
      }
      request.off("data", take);
      request.pause();
      resolve(null);
    };
    request.on("data", take);
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("close", () => resolve(undefined));
  });

/**
 * The request as React Router's adapter reads it, its body the bytes already
 * read rather than the socket they came from; everything else is the
 * request's own.
 */
const carrying = (request: Request, body: Buffer): Request => {
  const bytes = Readable.from([body]);
  const replay = Object.create(request) as Request;
  for (const name of ["on", "once", "off", "pause", "resume", "destroy"] as const) {
    Object.defineProperty(replay, name, { value: bytes[name].bind(bytes) });
  }
  Object.defineProperty(replay, "readable", { get: () => bytes.readable });
  return replay;
};

/** The API's refusal of a body over the limit; the connection is closed rather than read to its end. */
const tooLarge = async (request: Request, response: Response): Promise<void> => {
  const refusal = errorResponse(
    new Request(new URL(request.originalUrl, "http://scanner.invalid"), {
      method: request.method,
      headers: { "x-request-id": request.get("x-request-id") ?? "" },
    }),
    413,
    "body_too_large",
    "The request body is larger than 64 KiB, the most this server reads.",
  );
  response.status(refusal.status).setHeader("connection", "close");
  for (const [name, value] of refusal.headers) response.setHeader(name, value);
  response.send(await refusal.text());
};

export function scannerApp(parts: ScannerParts): Express {
  const app = express();
  app.use((request, response, next) => {
    const routeClass = classifyHttpRoute(request.path);
    telemetry.observeHttp("scanner", request, response, () => routeClass);
    next();
  });
  app.disable("x-powered-by");
  app.set("etag", false);
  const routes = routeTree(build);

  app.use((_request, response, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    next();
  });

  app.use((request, response, next) => {
    if (UNCARRIED.has(request.method)) {
      plainly(response, 405, "Method Not Allowed");
      return;
    }
    next();
  });

  // `/methodology/` is `/methodology`, permanently, with the query kept. A
  // path written with repeated slashes or a backslash is sent first to the
  // same path with single slashes, so no address it is sent to starts with
  // `//`, which a browser reads as another site.
  app.use((request, response, next) => {
    const at = request.originalUrl.indexOf("?");
    const path = at === -1 ? request.originalUrl : request.originalUrl.slice(0, at);
    const single = path.replace(/[/\\]+/g, "/");
    const to =
      single !== path ? single : path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : null;
    if (to === null) {
      next();
      return;
    }
    const location = `${to}${at === -1 ? "" : request.originalUrl.slice(at)}`;
    response.status(308).setHeader("location", location);
    response.setHeader("refresh", `0;url=${location}`);
    response.end(location);
  });

  // A path that cannot be decoded is no address of the scanner's, and React
  // Router would write it, as the stranger sent it, to the log. Nor is a
  // target that is no path, such as the `*` of `OPTIONS *`, which React
  // Router cannot read at all.
  app.use((request, response, next) => {
    if (request.originalUrl.startsWith("/") && decodes(request.path)) next();
    else plainly(response, 404, "Not Found");
  });

  // A page's data is asked for at `<page>.data`, and React Router would answer
  // the same address for a route that draws no page by running it, an API
  // route's action included, so no page's data is there to give.
  app.use((request, response, next) => {
    const { page, data } = pageOf(routedPath(request));
    const leaf = data ? matchRoutes(routes, page)?.at(-1)?.route : undefined;
    if ((leaf?.handle as { draws: boolean } | undefined)?.draws === false) {
      plainly(response, 404, "Not Found");
      return;
    }
    next();
  });

  if (parts.assets !== undefined) app.use("/assets", parts.assets);
  if (parts.files !== undefined) app.use(parts.files);

  // React Router refuses a method other than these with 405 before it looks
  // at the address, as a page refuses it. An address no route of its own
  // takes answers such a method as it answers a read, with the page that says
  // there is no such page.
  app.use((request, _response, next) => {
    if (!ROUTED_METHODS.has(request.method)) {
      const { page } = pageOf(routedPath(request));
      if (matchRoutes(routes, page)?.at(-1)?.route.path === "*") request.method = "GET";
    }
    next();
  });

  const handleRouted = createRequestHandler({ build, mode: parts.mode });
  app.use(async (request, response, next) => {
    if (request.method === "GET" || request.method === "HEAD") {
      await handleRouted(request, response, next);
      return;
    }
    if (Number(request.get("content-length") ?? 0) > BODY_LIMIT_BYTES) {
      await tooLarge(request, response);
      return;
    }
    const body = await boundedBody(request);
    if (body === undefined) return;
    if (body === null) await tooLarge(request, response);
    else await handleRouted(carrying(request, body), response, next);
  });

  app.use((thrown: unknown, request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(thrown);
      return;
    }
    logUnhandledRequestError(thrown, {
      method: request.method,
      path: request.path,
      requestId: request.get("x-request-id") ?? null,
    });
    plainly(response, 500, "Internal Server Error");
  });
  return app;
}

/** Long enough for an answer already being written to finish, short of Docker's ten seconds. */
const CLOSING_GRACE_MS = 5_000;

/**
 * Starts the built scanner, with the browser's files from `client`: on `PORT`
 * (3000) of `HOSTNAME` (every interface), with the background retry of
 * identity deletions where the dashboard's private route is configured. On
 * SIGTERM or SIGINT it stops taking requests, lets those in flight finish
 * within the grace, and exits. An exception or a rejection nothing caught
 * leaves the process in a state nobody knows, so it is logged by its kind
 * alone and the process exits with 1, for its supervisor to start afresh.
 *
 * The folder is named by the caller, because this code is wherever the build
 * put it: in `dist/server/index.js`, or in a chunk beside it once an
 * `import()` splits the build.
 */
export async function serve({ client }: Readonly<{ client: string }>): Promise<Server> {
  process.once("uncaughtException", (thrown) => {
    logBackgroundFailure("web_uncaught_exception", thrown);
    process.exit(1);
  });
  process.once("unhandledRejection", (thrown) => {
    logBackgroundFailure("web_unhandled_rejection", thrown);
    process.exit(1);
  });
  const app = scannerApp({
    assets: await precompressedFrom(join(client, "assets")),
    files: express.static(client, { index: false, redirect: false }),
    mode: "production",
  });
  const port = Number.parseInt(process.env.PORT ?? "", 10) || 3000;
  const host = process.env.HOSTNAME || "0.0.0.0";
  const server = app.listen(port, host);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  console.log(`[web] listening on ${host}:${port}`);
  const metrics = listenForMetrics();
  const retries = startPrivacyRetries(process.env, () =>
    Promise.all([retryPendingScannerIdentityDeletions(), retryDueDataCopies()]),
  );
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    process.once(signal, () => {
      retries.stop();
      metrics?.close();
      metrics?.closeAllConnections();
      server.close(() => process.exit(code));
      server.closeIdleConnections();
      setTimeout(() => process.exit(code), CLOSING_GRACE_MS).unref();
    });
  }
  return server;
}
