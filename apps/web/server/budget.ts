/**
 * The scanner's speed budget, checked against the build after
 * `pnpm --filter @agentify/web build` by the shared check in
 * `@agentify/ui/budget`: the brotli-compressed script of a page's first
 * visit, with what a page loads later, PostHog once a visitor allows it,
 * printed beside it. Each file is fetched from the
 * built scanner itself, so the header checked is the one a browser gets.
 */

import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { precompressedFrom } from "@agentify/ui/assets";
import { brokenBudget } from "@agentify/ui/budget";
import type { ServerBuild } from "react-router";
import type { ScannerParts } from "./app";

/** A page a stranger lands on: the front page, a landing, a notice, a shared result. */
const LANDING_BUDGET = 105 * 1024;

/**
 * A page reached by someone already using the scanner, whose script is the
 * scan's progress, the report's panels or an operator's figures.
 */
const WORKING_BUDGET = 130 * 1024;
const WORKING_PAGES = new Set([
  "routes/scan.id",
  "routes/scan.pending",
  "routes/report.scanId",
  "routes/report.latest",
  "routes/admin",
  "routes/data-request",
  "routes/email.unsubscribe",
]);

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const client = join(DIST, "client");
const built = (await import(pathToFileURL(join(DIST, "server", "index.js")).href)) as {
  build: ServerBuild;
  scannerApp: (parts: ScannerParts) => import("express").Express;
};
const app = built.scannerApp({
  assets: await precompressedFrom(join(client, "assets")),
  mode: "production",
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;
let failures: readonly string[];
try {
  failures = await brokenBudget({
    label: "[web]",
    build: built.build,
    clientDirectory: client,
    assetsAt: `http://127.0.0.1:${port}/assets`,
    limitOf: (id) => (WORKING_PAGES.has(id) ? WORKING_BUDGET : LANDING_BUDGET),
  });
} finally {
  server.close();
}
if (failures.length > 0) {
  console.error(`[web] the speed budget is broken:\n${failures.join("\n")}`);
  process.exit(1);
}
