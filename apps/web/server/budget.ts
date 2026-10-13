/**
 * The scanner's speed budget, checked against the build after
 * `pnpm --filter @agentify/web build` by the shared check in
 * `@agentify/ui/budget`: at most 100 KB of brotli-compressed script on a
 * page's first visit, with what a page loads later, PostHog once a visitor
 * allows it and Stripe on the card step, printed beside it. Each file is
 * fetched from the built scanner itself, so the header checked is the one a
 * browser gets.
 */

import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { precompressedFrom } from "@agentify/ui/assets";
import { brokenBudget } from "@agentify/ui/budget";
import type { ServerBuild } from "react-router";
import type { ScannerParts } from "./app";

const SCRIPT_BUDGET = 100 * 1024;

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
    limit: SCRIPT_BUDGET,
  });
} finally {
  server.close();
}
if (failures.length > 0) {
  console.error(`[web] the speed budget is broken:\n${failures.join("\n")}`);
  process.exit(1);
}
