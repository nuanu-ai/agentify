/**
 * The last step of `pnpm --filter @agentify/dashboard build`: a brotli copy at
 * its highest quality and a gzip copy beside every script and stylesheet the
 * build wrote for the browser, so the server sends the smaller file without
 * compressing on each request. The edge in front of the dashboard has no
 * brotli encoder of its own. Run after React Router's build rather than inside
 * it, because the route manifest is written by its server half, after the
 * browser's.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const assets = fileURLToPath(new URL("../dist/client/assets", import.meta.url));

const written = (await readdir(assets)).filter((name) => /\.(?:js|css)$/.test(name));
await Promise.all(
  written.map(async (name) => {
    const path = join(assets, name);
    const body = await readFile(path);
    await writeFile(
      `${path}.br`,
      brotliCompressSync(body, {
        params: {
          [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
          [constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      }),
    );
    await writeFile(`${path}.gz`, gzipSync(body, { level: constants.Z_BEST_COMPRESSION }));
  }),
);
console.log(
  `[dashboard] ${written.length} scripts and stylesheets written compressed beside themselves`,
);
