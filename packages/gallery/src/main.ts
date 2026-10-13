/**
 * `pnpm gallery`: draws every registered surface's states and writes the page
 * to `dist/index.html`, ready to publish as it is, or says why it would not be.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DrawnSurface, drawSurface, SHARED_FILES } from "./draw.js";
import { pageOf, productFonts } from "./page.js";
import { SURFACES } from "./surfaces.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const OUT = fileURLToPath(new URL("../dist/index.html", import.meta.url));

const surfaces: DrawnSurface[] = [];
for (const source of SURFACES) surfaces.push(await drawSurface(source));

const mark = await readFile(join(SHARED_FILES, "assets", "agentify-mark.svg"));
const page = pageOf({
  surfaces,
  fonts: await productFonts(),
  css: await readFile(join(HERE, "chrome.css"), "utf8"),
  script: await readFile(join(HERE, "chrome.js"), "utf8"),
  mark: `data:image/svg+xml;base64,${mark.toString("base64")}`,
});

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, page);
const states = surfaces.reduce((sum, surface) => sum + surface.states.length, 0);
console.log(
  `${states} states of ${surfaces.length} surface${surfaces.length === 1 ? "" : "s"}` +
    ` written to ${OUT}, ${(Buffer.byteLength(page) / 1024 / 1024).toFixed(2)} MB.`,
);
