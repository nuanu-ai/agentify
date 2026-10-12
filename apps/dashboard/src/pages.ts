/**
 * The dashboard's React pages, mounted on its listener in front of the pages
 * still drawn as strings. A request is handed to React Router only where one of
 * its routes answers that path with that method; everything else falls through
 * to the string handlers, so a screen moves by adding its route here and
 * deleting its string handler in the same change.
 *
 * What the pages need from the process — the session lookup, the gateway as
 * the signed-in merchant, the configuration — reaches their loaders through the
 * request context under the key the build itself exports, and nothing else
 * crosses: no credential, key or route is added for them. The origin check and
 * everything above the body parser in `server.ts` run before this.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequestHandler } from "@react-router/express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  matchRoutes,
  type RouteObject,
  type RouterContext,
  RouterContextProvider,
  type ServerBuild,
} from "react-router";
import type { PageServices } from "./page-services.js";

// What React Router's type generation would declare for `future.v8_middleware`
// in `react-router.config.ts`: loaders, actions and the server's load context
// are typed for a context provider rather than a plain object.
declare module "react-router" {
  interface Future {
    v8_middleware: true;
  }
}

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILT_SERVER = join(APP_ROOT, "dist", "server", "index.js");

/** The largest form any page here posts, and more than any of them needs. */
const FORM_AT_MOST = 16 * 1024;

/**
 * The pages as one build: compiled ahead of time in a deployment, or compiled
 * from source on each request by Vite where a developer or a test runs them.
 */
export interface Pages {
  readonly build: ServerBuild | (() => Promise<ServerBuild>);
  /**
   * Answers the browser's requests for scripts and styles under `path`; null
   * where no browser asks.
   */
  readonly assets: Readonly<{ path: string; handle: RequestHandler }> | null;
  /** Development shows a failing loader's error on the page; production never does. */
  readonly mode: "production" | "development";
  close(): Promise<void>;
}

/**
 * The build the image compiled. A deployment without it is refused at start
 * rather than serving a dashboard whose sign-in is missing.
 */
export async function builtPages(): Promise<Pages> {
  if (!existsSync(BUILT_SERVER)) {
    throw new Error(
      `The dashboard cannot start: its pages are not built at ${BUILT_SERVER}. ` +
        "Build them with `pnpm --filter @agentify/dashboard build`, or start the app with " +
        "`pnpm --filter @agentify/app dev`, which compiles them from source.",
    );
  }
  const build = (await import(BUILT_SERVER)) as ServerBuild;
  return { build, assets: null, mode: "production", close: async () => {} };
}

/**
 * The pages compiled from source by Vite in middleware mode. `live` serves the
 * browser's modules and reloads them on an edit, for a developer; without it
 * nothing is watched or served to a browser, which is what a test wants.
 */
export async function pagesFromSource({ live }: { readonly live: boolean }): Promise<Pages> {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: APP_ROOT,
    configFile: join(APP_ROOT, "vite.config.ts"),
    appType: "custom",
    logLevel: live ? "info" : "silent",
    server: { middlewareMode: true, hmr: live, ...(live ? {} : { watch: null }) },
    ...(live ? {} : { optimizeDeps: { noDiscovery: true, include: [] } }),
  });
  return {
    build: async () =>
      (await vite.ssrLoadModule("virtual:react-router/server-build")) as ServerBuild,
    assets: live ? { path: "/", handle: vite.middlewares } : null,
    mode: live ? "development" : "production",
    close: () => vite.close(),
  };
}

/** Which methods a route answers: a read where it draws a page or loads data, a post where it acts. */
type Answers = (method: string) => boolean;

/**
 * The build's routes as a tree, for asking whether a path is one of them
 * before handing the request over.
 */
const routesOf = (build: ServerBuild): RouteObject[] => {
  const childrenOf = (parentId: string | undefined): RouteObject[] =>
    Object.values(build.routes).flatMap((route): RouteObject[] => {
      if (route === undefined || route.parentId !== parentId) return [];
      const module = route.module as { default?: unknown; loader?: unknown; action?: unknown };
      // A layout with no path of its own, the root among them, is a frame
      // around pages and never a page, even while nothing is nested in it.
      const page = route.index === true || (route.path ?? "") !== "";
      const answers: Answers = (method) =>
        page &&
        (method === "GET" || method === "HEAD"
          ? module.default !== undefined || module.loader !== undefined
          : module.action !== undefined);
      const shared = {
        id: route.id,
        caseSensitive: route.caseSensitive === true,
        handle: { answers },
      };
      return [
        route.index === true
          ? { ...shared, index: true, ...(route.path === undefined ? {} : { path: route.path }) }
          : {
              ...shared,
              ...(route.path === undefined ? {} : { path: route.path }),
              children: childrenOf(route.id),
            },
      ];
    });
  return childrenOf(undefined);
};

/**
 * The path a request is about: a data request for a page is about the page,
 * and `_root.data` is about the root the router is mounted at.
 */
const pageOf = (path: string, basename: string): string => {
  if (path === `${basename.replace(/\/$/, "")}/_root.data`) return basename;
  const page = path.endsWith(".data") ? path.slice(0, -".data".length) : path;
  return page.length > 1 && page.endsWith("/") ? page.slice(0, -1) : page;
};

interface Mounted {
  readonly build: ServerBuild;
  readonly routes: RouteObject[];
  readonly handle: RequestHandler;
}

/**
 * The React pages as one Express handler for the dashboard's listener. The
 * build's own prefix is replaced by the one the dashboard is configured with,
 * so a dashboard at the root of its origin answers there too; the browser's
 * files stay where the build put them.
 */
export function pagesHandler(pages: Pages, services: PageServices): RequestHandler {
  const basename = services.base === "" ? "/" : services.base;
  const mounted = new WeakMap<ServerBuild, Mounted>();

  const mount = (compiled: ServerBuild): Mounted => {
    const known = mounted.get(compiled);
    if (known !== undefined) return known;
    const key = (compiled.entry.module as { services?: RouterContext<PageServices> }).services;
    if (key === undefined) {
      throw new Error(
        "The dashboard's pages do not export the key their services go under, `services` in" +
          " app/entry.server.tsx, so no page could reach the session or the gateway.",
      );
    }
    const build: ServerBuild = { ...compiled, basename };
    const made: Mounted = {
      build,
      routes: routesOf(build),
      handle: createRequestHandler({
        build,
        mode: pages.mode,
        getLoadContext: () => new RouterContextProvider(new Map([[key, services]])),
      }) as RequestHandler,
    };
    mounted.set(compiled, made);
    return made;
  };

  const manifestPath = (build: ServerBuild): string =>
    `${basename.replace(/\/$/, "")}${build.routeDiscovery.manifestPath}`;

  return (request: Request, response: Response, next: NextFunction): void => {
    void (async () => {
      const { build, routes, handle } = mount(
        typeof pages.build === "function" ? await pages.build() : pages.build,
      );
      if (request.path === manifestPath(build)) {
        handle(request, response, next);
        return;
      }
      const matches = matchRoutes(routes, pageOf(request.path, basename), basename);
      const answers = (matches?.at(-1)?.route.handle as { answers?: Answers } | undefined)?.answers;
      if (answers === undefined || !answers(request.method)) {
        next();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        // React Router reads a form whole; a body that does not say how long
        // it is, or says it is longer than any form here, is refused before
        // that, as the body parser refuses one for the string pages.
        const length = Number(request.headers["content-length"] ?? Number.NaN);
        if (!(length <= FORM_AT_MOST)) {
          next(Object.assign(new Error("request entity too large"), { type: "entity.too.large" }));
          return;
        }
      }
      // A page here may show the signed-in address, so no shared cache keeps
      // any answer. A page's data may be kept by this browser for ten seconds,
      // because a browser hands a prefetched answer to the click that follows
      // only while it is fresh; it is kept per session cookie, and a post to
      // the same address drops it, so nothing is drawn from data older than a
      // change made since.
      const reading = request.method === "GET" || request.method === "HEAD";
      if (reading && request.path.endsWith(".data")) {
        response.setHeader("cache-control", "private, max-age=10");
        response.setHeader("vary", "cookie");
      } else {
        response.setHeader("cache-control", "private, no-store");
      }
      handle(request, response, next);
    })().catch(next);
  };
}
