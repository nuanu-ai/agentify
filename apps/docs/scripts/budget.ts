/**
 * The documentation's speed budget, checked against the build after
 * `pnpm --filter @agentify/docs build` by the shared check in
 * `@agentify/ui/budget`: the brotli-compressed script a page loads on its
 * first visit, with what it loads later, the search, printed beside it. Each
 * file is fetched through the stand-in for Caddy's `/docs` block, which reads
 * the cache lifetime of the assets from the Caddyfile, so the header checked
 * is the one the Caddyfile promises.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { brokenBudget } from "@agentify/ui/budget";
import type { ServerBuild } from "react-router";
import { BUILT, CHANNELS, standEdge } from "../testing/edge.js";

/** As the dashboard's: a page of reading loads no more script than a page of work. */
const SCRIPT_BUDGET = 100 * 1024;

const SERVER = fileURLToPath(new URL("../dist/server/index.js", import.meta.url));
const build = (await import(pathToFileURL(SERVER).href)) as ServerBuild;
const edge = await standEdge({ environment: CHANNELS.live });
let failures: readonly string[];
try {
  failures = await brokenBudget({
    label: "[docs]",
    build,
    clientDirectory: BUILT,
    assetsAt: `${edge.origin}/docs/assets`,
    limitOf: () => SCRIPT_BUDGET,
  });
} finally {
  await edge.close();
}
if (failures.length > 0) {
  console.error(`[docs] the speed budget is broken:\n${failures.join("\n")}`);
  process.exit(1);
}
