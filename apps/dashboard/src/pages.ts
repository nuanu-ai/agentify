/**
 * The dashboard's React pages, React Router 8 in framework mode, mounted on its
 * listener in front of the pages still drawn as strings. A request is handed to
 * React Router only where one of its routes answers that path with that
 * method; everything else falls through to the string handlers, so a screen
 * moves by adding its route here and deleting its string handler in the same
 * change.
 *
 * What the pages need from the process — the session lookup, the gateway as
 * the signed-in merchant, the configuration — reaches their loaders through the
 * request context under the key the build itself exports, and nothing else
 * crosses: no credential, key or route is added for them. The origin check and
 * everything above the body parser in `server.ts` run before this.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
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

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILT_SERVER = join(APP_ROOT, "dist", "server", "index.js");

/** Where Vite puts the browser's files, under the build's public path. */
const ASSETS_DIRECTORY = "assets";
const BUILT_ASSETS = join(APP_ROOT, "dist", "client", ASSETS_DIRECTORY);

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
  return {
    build,
    assets: {
      path: `${build.publicPath}${ASSETS_DIRECTORY}`,
      handle: await precompressedFrom(BUILT_ASSETS),
    },
    mode: "production",
    close: async () => {},
  };
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
    assets: live
      ? {
          path: "/",
          // Vite takes its base off the address of every request it passes
          // on, so the address is put back before the dashboard's own
          // handlers read it.
          handle: (request, response, next) => {
            const asked = request.url;
            vite.middlewares(request, response, () => {
              request.url = asked;
              next();
            });
          },
        }
      : null,
    mode: live ? "development" : "production",
    close: () => vite.close(),
  };
}

/**
 * Which methods a route answers: a read where it loads data or draws a page
 * that acts on nothing, and a post where it acts. A route that only draws the
 * answer to its own post, which it needs a component for, is not opened by a
 * read. No other method reaches an action, because the origin check reads
 * posts alone.
 */
type Answers = (method: string) => boolean;

interface Served {
  readonly answers: Answers;
  /**
   * Whether a browser may keep the page's data for a moment. A page sent with
   * no script never has its data asked for by its own page, so whatever asks
   * for it is not a prefetch, and nothing of it is kept.
   */
  readonly keepsData: boolean;
}

/**
 * The build's routes as a tree, for asking whether a path is one of them
 * before handing the request over.
 */
const routesOf = (build: ServerBuild): RouteObject[] => {
  const childrenOf = (parentId: string | undefined): RouteObject[] =>
    Object.values(build.routes).flatMap((route): RouteObject[] => {
      if (route === undefined || route.parentId !== parentId) return [];
      const module = route.module as {
        default?: unknown;
        loader?: unknown;
        action?: unknown;
        handle?: { script?: boolean };
      };
      // A layout with no path of its own, the root among them, is a frame
      // around pages and never a page, even while nothing is nested in it.
      const page = route.index === true || (route.path ?? "") !== "";
      const served: Served = {
        answers: (method) =>
          page &&
          (method === "GET" || method === "HEAD"
            ? module.loader !== undefined ||
              (module.default !== undefined && module.action === undefined)
            : method === "POST" && module.action !== undefined),
        keepsData: module.handle?.script !== false,
      };
      const shared = {
        id: route.id,
        caseSensitive: route.caseSensitive === true,
        handle: served,
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
 * The path a request is about, read as React Router reads it: a data request
 * for a page is about the page, `/_.data` standing for the page's address with
 * its trailing slash.
 */
const pageOf = (path: string): string => {
  const page = path.endsWith("/_.data")
    ? path.slice(0, -"_.data".length)
    : path.endsWith(".data")
      ? path.slice(0, -".data".length)
      : path;
  return page.length > 1 && page.endsWith("/") ? page.slice(0, -1) : page;
};

const decodes = (path: string): boolean => {
  try {
    decodeURI(path);
    return true;
  } catch {
    return false;
  }
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
    const build: ServerBuild = {
      ...compiled,
      basename,
      // React Router refuses a post whose `Origin` differs from the request's
      // own address, scheme included, and behind a terminator that sets no
      // forwarded header the scheme it sees is not the browser's, so every
      // honest post would be refused. The dashboard's own check, which runs
      // before any request reaches here, compares hosts and has already
      // turned away a post from anywhere else.
      allowedActionOrigins: ["**"],
    };
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
      // A path that cannot be decoded is no address any route could have, and
      // matching it would have React Router write it, as the stranger sent
      // it, to the log; the route table matches each path it is asked about.
      const asked = request.path === manifestPath(build);
      const paths = asked
        ? (new URLSearchParams(request.url.split("?")[1] ?? "").get("paths") ?? "").split(",")
        : [request.path];
      if (!paths.every(decodes)) {
        if (asked) {
          response.status(400).type("text/plain").send("Invalid Request");
        } else {
          next();
        }
        return;
      }
      if (asked) {
        handle(request, response, next);
        return;
      }
      const matches = matchRoutes(routes, pageOf(request.path), basename);
      const served = matches?.at(-1)?.route.handle as Served | undefined;
      if (served === undefined || !served.answers(request.method)) {
        next();
        return;
      }
      if (request.method === "POST") {
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
      // per session cookie, because a browser hands a prefetched answer to the
      // click that follows only while it is fresh. The price: a press posted
      // to another address, such as a string page's switch, does not drop the
      // data kept for this one, so for up to ten seconds after it a page opened
      // inside the application may show its data from before the press. An
      // action React Router sends posts to its own page's address and drops
      // that page's data.
      const reading = request.method === "GET" || request.method === "HEAD";
      if (reading && request.path.endsWith(".data") && served.keepsData) {
        response.setHeader("cache-control", "private, max-age=10");
        response.setHeader("vary", "cookie");
      } else {
        response.setHeader("cache-control", "private, no-store");
      }
      handle(request, response, next);
    })().catch(next);
  };
}

const TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * The encodings a browser accepts, best first. Only the ones the build writes
 * are asked about; one named with `q=0` is refused, as the header's grammar
 * says.
 */
const accepted = (header: string | undefined): readonly string[] => {
  const said = (header ?? "").split(",").map((part) => {
    const [name = "", ...parameters] = part.trim().toLowerCase().split(";");
    const refused = parameters.some((parameter) => /^\s*q=0(?:\.0*)?\s*$/.test(parameter));
    return refused ? "" : name.trim();
  });
  return ["br", "gzip"].filter((encoding) => said.includes(encoding) || said.includes("*"));
};

/**
 * The built scripts and styles, which carry a content hash in their names and
 * so may be kept by any cache for a year. Each is sent compressed as the build
 * wrote it where the browser accepts that encoding. Only files listed when the
 * process started are answered, so no path in a request reaches the disk.
 */
export async function precompressedFrom(directory: string): Promise<RequestHandler> {
  const names = new Set(await readdir(directory));
  return (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(request.path.slice(1));
    } catch {
      name = "";
    }
    const type = TYPES[extname(name)];
    if (!names.has(name) || type === undefined) {
      response.status(404).type("text/plain").send("No such file.");
      return;
    }
    const encoding = accepted(request.headers["accept-encoding"]).find((each) =>
      names.has(`${name}.${each === "gzip" ? "gz" : each}`),
    );
    // Named under the directory rather than joined to it, so a directory with a
    // dot in its path, a checkout under a tool's hidden one, is not refused as
    // a dotfile; and the headers are given to the send, so a send that fails
    // leaves none of them on the error page.
    response.sendFile(
      encoding === undefined ? name : `${name}.${encoding === "gzip" ? "gz" : encoding}`,
      {
        root: directory,
        maxAge: "1y",
        immutable: true,
        headers: {
          "content-type": type,
          vary: "accept-encoding",
          ...(encoding === undefined ? {} : { "content-encoding": encoding }),
        },
      },
      (error) => {
        if (error !== undefined && !response.headersSent) next(error);
      },
    );
  };
}
