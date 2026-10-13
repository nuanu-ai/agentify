/**
 * The scanner compiled from source by Vite in middleware mode, for a developer
 * (`pnpm --filter @agentify/web dev`) and for the tests that answer requests
 * the way the built process does. `live` serves the browser's modules and
 * reloads them on an edit; without it nothing is watched or served to a
 * browser, which is what a test wants.
 */

import type { RequestListener } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import type { AliasOptions } from "vite";
import type { ScannerParts } from "./app";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACE = join(APP_ROOT, "..", "..");

export const LOOPBACK = "127.0.0.1";

export interface FromSource {
  /**
   * The scanner's whole process as one listener for a Node server, compiled
   * again after an edit. It stands on its own rather than inside another
   * Express application, whose own headers would be added to every answer.
   */
  readonly listener: RequestListener;
  /** Loads a module of the scanner through the same compiler, as the process sees it. */
  load<Module>(path: string): Promise<Module>;
  close(): Promise<void>;
}

export async function scannerFromSource({
  live,
  alias,
}: Readonly<{
  live: boolean;
  /** Where a test points the workspace's packages at their source instead of their build. */
  alias?: AliasOptions;
}>): Promise<FromSource> {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: APP_ROOT,
    configFile: join(APP_ROOT, "vite.config.ts"),
    appType: "custom",
    logLevel: live ? "info" : "silent",
    ...(alias === undefined ? {} : { resolve: { alias } }),
    server: {
      middlewareMode: true,
      // Live, Vite answers for source files and pushes updates over a socket
      // of its own, and both answer on loopback only: that is the boundary.
      hmr: live ? { host: LOOPBACK } : false,
      fs: {
        allow: [APP_ROOT, join(WORKSPACE, "packages"), join(WORKSPACE, "node_modules")],
      },
      ...(live ? {} : { watch: null }),
    },
    ...(live ? {} : { optimizeDeps: { noDiscovery: true, include: [] } }),
  });
  const load = <Module>(path: string) => vite.ssrLoadModule(path) as Promise<Module>;
  const apps = new WeakMap<object, Express>();
  const parts: ScannerParts = {
    mode: live ? "development" : "production",
    // Vite serves the browser's modules and `public/` at their own addresses.
    ...(live ? { files: vite.middlewares } : {}),
  };
  return {
    listener: (request, response) => {
      void load<typeof import("./app")>("/server/app.ts").then(
        (module) => {
          let app = apps.get(module);
          if (app === undefined) {
            app = module.scannerApp(parts);
            apps.set(module, app);
          }
          app(request, response);
        },
        () => {
          response.statusCode = 500;
          response.end("The scanner could not be compiled; Vite's output says why.");
        },
      );
    },
    load,
    close: () => vite.close(),
  };
}
