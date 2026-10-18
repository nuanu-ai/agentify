/**
 * The dashboard's speed budget, checked against the build after
 * `pnpm --filter @agentify/dashboard build` by the shared check in
 * `@agentify/ui/budget`, with each file fetched through the dashboard's own
 * asset handler. A page sent with no script loads none and is left out.
 */

import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { brokenBudget } from "@agentify/ui/budget";
import express from "express";
import type { ServerBuild } from "react-router";
import { builtPages } from "./pages.js";

/** A little above what the heaviest page loads, so a page that grows is caught here. */
const SCRIPT_BUDGET = 100 * 1024;

const pages = await builtPages();
const build = pages.build as ServerBuild;
if (pages.assets === null) throw new Error("the built pages serve no scripts or styles");

const app = express();
app.use(pages.assets.path, pages.assets.handle);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;
let failures: readonly string[];
try {
  failures = await brokenBudget({
    label: "[dashboard]",
    build,
    clientDirectory: fileURLToPath(new URL("../dist/client", import.meta.url)),
    assetsAt: `http://127.0.0.1:${port}${pages.assets.path}`,
    limitOf: () => SCRIPT_BUDGET,
    scriptless: (id) =>
      (build.routes[id]?.module as { handle?: { script?: boolean } } | undefined)?.handle
        ?.script === false,
  });
} finally {
  server.close();
}
if (failures.length > 0) {
  console.error(`[dashboard] the speed budget is broken:\n${failures.join("\n")}`);
  process.exit(1);
}
