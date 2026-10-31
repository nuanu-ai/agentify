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

import { SCRIPT_BUDGET } from "./script-budget.js";

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
    // The nearest explicit handle owns this page, as in the root document.
    scriptless: (id) => {
      for (let at: string | undefined = id; at !== undefined; at = build.routes[at]?.parentId) {
        const handle = (
          build.routes[at]?.module as { handle?: { script?: boolean | string } } | undefined
        )?.handle;
        if (handle?.script !== undefined) return handle.script === false;
      }
      return false;
    },
  });
} finally {
  server.close();
}
if (failures.length > 0) {
  console.error(`[dashboard] the speed budget is broken:\n${failures.join("\n")}`);
  process.exit(1);
}
