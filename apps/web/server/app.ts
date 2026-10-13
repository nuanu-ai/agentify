/**
 * The scanner's process: Express in front of React Router, which answers every
 * page and every API route (`app/routes.ts`). What stands in front of it is
 * short. Every answer carries the security headers; an address with a trailing
 * or a repeated slash is sent to the one without it; the browser's built files
 * are served with a year's cache and the files copied from `public/` as they
 * are.
 *
 * `trust proxy` stays off: what the scanner knows of a visitor's address it
 * reads from the `X-Forwarded-For` the edge writes, and Express would put a
 * value spoofable by any other peer behind `request.ip` and `request.secure`.
 *
 * This file is the server half of the build: `dist/server/index.js` is this
 * module with React Router's build and every package it imports inside it,
 * and `server.js` starts it.
 */

import type { Server } from "node:http";
import { join } from "node:path";
import * as build from "virtual:react-router/server-build";
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
import { logBackgroundFailure, logUnhandledRequestError } from "../lib/server/http";
import { retryPendingScannerIdentityDeletions } from "../lib/server/scanner-identity-deletion";
import { startDeletionRetries } from "./deletion-retries";

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

/** A short plain answer of the process's own, which nobody keeps. */
const plainly = (response: Response, status: number, words: string): void => {
  response.status(status).setHeader("cache-control", UNKEPT_PAGE_CACHE);
  response.type("text/plain").send(words);
};

export function scannerApp(parts: ScannerParts): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  const routes = routeTree(build);

  app.use((_request, response, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
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
  // Router would write it, as the stranger sent it, to the log.
  app.use((request, response, next) => {
    try {
      decodeURI(request.path);
      next();
    } catch {
      plainly(response, 404, "Not Found");
    }
  });

  // A page's data is asked for at `<page>.data`, and React Router would answer
  // the same address for a route that draws no page by running it, an API
  // route's action included, so no page's data is there to give. The path is
  // read as React Router reads it, with `/./`, `/../` and `%2e` taken out.
  app.use((request, response, next) => {
    const { page, data } = pageOf(new URL(request.originalUrl, "http://scanner.invalid").pathname);
    const leaf = data ? matchRoutes(routes, page)?.at(-1)?.route : undefined;
    if ((leaf?.handle as { draws: boolean } | undefined)?.draws === false) {
      plainly(response, 404, "Not Found");
      return;
    }
    next();
  });

  if (parts.assets !== undefined) app.use("/assets", parts.assets);
  if (parts.files !== undefined) app.use(parts.files);
  app.use(createRequestHandler({ build, mode: parts.mode }));

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
  const retries = startDeletionRetries(process.env, retryPendingScannerIdentityDeletions);
  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    process.once(signal, () => {
      retries.stop();
      server.close(() => process.exit(code));
      server.closeIdleConnections();
      setTimeout(() => process.exit(code), CLOSING_GRACE_MS).unref();
    });
  }
  return server;
}
