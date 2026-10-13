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
import { fileURLToPath } from "node:url";
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
import { SECURITY_HEADERS } from "../lib/server/answer-headers";
import { logUnhandledRequestError } from "../lib/server/http";
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

export function scannerApp(parts: ScannerParts): Express {
  const app = express();
  app.disable("x-powered-by");

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
      response.status(404).type("text/plain").send("Not Found");
    }
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
    response.status(500).type("text/plain").send("Internal Server Error");
  });
  return app;
}

/** Long enough for an answer already being written to finish, short of Docker's ten seconds. */
const CLOSING_GRACE_MS = 5_000;

/**
 * Starts the built scanner: on `PORT` (3000) of `HOSTNAME` (every interface),
 * with the background retry of identity deletions where the dashboard's
 * private route is configured. On SIGTERM or SIGINT it stops taking requests,
 * lets those in flight finish within the grace, and exits.
 */
export async function serve(): Promise<Server> {
  const client = fileURLToPath(new URL("../client", import.meta.url));
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
