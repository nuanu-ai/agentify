/**
 * The dashboard's speed budget, checked against the build after
 * `pnpm --filter @agentify/dashboard build`: it fails when the script any page
 * loads on its first visit, compressed with brotli as it is sent, grows past
 * `SCRIPT_BUDGET`, or when a file the build wrote for the browser lacks the
 * content hash in its name or is served without the year-long immutable cache
 * the hash makes safe. Each file is fetched through the dashboard's own asset
 * handler, so the header checked is the one a browser gets.
 *
 * It counts what a page loads before any script runs: React Router's entry, the
 * route table, and the modules of every route from the root to the page with
 * what they import. A chunk fetched later, on hover or on a click, is not
 * counted, and neither is the stylesheet. A page sent with no script loads none
 * and is left out.
 */

import { readdir, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { ServerBuild } from "react-router";
import { builtPages } from "./pages.js";

/** A little above the 95 KB the heaviest page loads today. */
const SCRIPT_BUDGET = 100 * 1024;

/** The eight characters Vite writes into a name from the file's content. */
const HASHED = /-[\w-]{8}\.(?:js|css)$/;

const IMMUTABLE = "public, max-age=31536000, immutable";

const ASSETS = fileURLToPath(new URL("../dist/client/assets", import.meta.url));

const pages = await builtPages();
const build = pages.build as ServerBuild;
const failures: string[] = [];

const brotliSize = async (url: string): Promise<number> => {
  const name = url.slice(url.lastIndexOf("/") + 1);
  return (await stat(join(ASSETS, `${name}.br`))).size;
};

const loads = async (leafId: string): Promise<number> => {
  const files = new Set([
    build.assets.url,
    build.assets.entry.module,
    ...build.assets.entry.imports,
  ]);
  for (let id: string | undefined = leafId; id !== undefined; id = build.routes[id]?.parentId) {
    const route = build.assets.routes[id];
    if (route === undefined) continue;
    files.add(route.module);
    for (const imported of route.imports ?? []) files.add(imported);
  }
  const sizes = await Promise.all([...files].map(brotliSize));
  return sizes.reduce((sum, size) => sum + size, 0);
};

const scriptless = (id: string): boolean =>
  (build.routes[id]?.module as { handle?: { script?: boolean } } | undefined)?.handle?.script ===
  false;
const leaves = Object.keys(build.routes).filter(
  (id) => !Object.values(build.routes).some((route) => route?.parentId === id) && !scriptless(id),
);
const measured = await Promise.all(leaves.map(async (id) => [id, await loads(id)] as const));
measured.sort(([, a], [, b]) => b - a);
for (const [id, size] of measured) {
  const over = size > SCRIPT_BUDGET;
  console.log(`${over ? "OVER " : "     "}${(size / 1024).toFixed(1).padStart(6)} KB  ${id}`);
  if (over) failures.push(`${id} loads ${size} bytes of script, over ${SCRIPT_BUDGET}`);
}

const written = (await readdir(ASSETS)).filter((name) => /\.(?:js|css)$/.test(name));
for (const name of written) {
  if (!HASHED.test(name)) failures.push(`${name} carries no content hash in its name`);
}

const app = express();
if (pages.assets === null) throw new Error("the built pages serve no scripts or styles");
app.use(pages.assets.path, pages.assets.handle);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;
try {
  for (const name of written) {
    const answered = await fetch(`http://127.0.0.1:${port}${pages.assets.path}/${name}`, {
      headers: { "accept-encoding": "br" },
    });
    await answered.arrayBuffer();
    const cache = answered.headers.get("cache-control");
    if (answered.status !== 200 || cache !== IMMUTABLE) {
      failures.push(`${name} is answered ${answered.status} with cache-control ${cache}`);
    }
  }
} finally {
  server.close();
}

if (failures.length > 0) {
  console.error(`[dashboard] the speed budget is broken:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  `[dashboard] every page loads at most ${SCRIPT_BUDGET / 1024} KB of script, and all ${written.length} files are hashed and kept for a year`,
);
