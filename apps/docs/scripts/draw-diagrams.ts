/**
 * `pnpm --filter @agentify/docs diagrams`: draws every Mermaid diagram the
 * pages write that has no drawing yet into `diagrams/`, and deletes the
 * drawings no page writes any more. Mermaid lays text out by measuring it in
 * a browser, so it draws in Playwright's Chromium with the site's own face
 * loaded at every weight it serves and named in the diagram: a label measured
 * in one face and shown in another runs out of its box. What it writes is
 * committed with the page.
 */

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  DIAGRAM_FACE,
  DIAGRAM_FAMILY,
  DIAGRAMS,
  diagramKey,
  LABEL_ROOM_PX,
} from "../app/diagrams.server.js";
import { diagramSources } from "../app/markdown.server.js";

const require = createRequire(import.meta.url);
const MERMAID = require.resolve("mermaid/dist/mermaid.min.js");

const wanted = new Map((await diagramSources()).map((source) => [diagramKey(source), source]));
const kept = new Set(
  (await readdir(DIAGRAMS).catch(() => [])).map((name) => name.replace(/\.svg$/, "")),
);

for (const key of kept) {
  if (!wanted.has(key)) {
    await rm(join(DIAGRAMS, `${key}.svg`));
    console.log(`[docs] deleted ${key}.svg, which no page draws`);
  }
}

const missing = [...wanted].filter(([key]) => !kept.has(key));
if (missing.length > 0) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const face = (await readFile(DIAGRAM_FACE)).toString("base64");
    await page.setContent(
      // The padding exists only on this page: the drawing keeps the wider box
      // Mermaid measured, and the page shows the label without it.
      `<!doctype html><style>@font-face{font-family:"Schibsted Grotesk";font-weight:400 700;src:url(data:font/woff2;base64,${face}) format("woff2")}body{font-family:${DIAGRAM_FAMILY}}foreignObject>div{padding-inline:${LABEL_ROOM_PX}px}</style><body></body>`,
    );
    await page.addScriptTag({ path: MERMAID });
    await page.evaluate(() =>
      Promise.all([
        document.fonts.load('16px "Schibsted Grotesk"'),
        document.fonts.load('bold 16px "Schibsted Grotesk"'),
      ]),
    );
    for (const [key, source] of missing) {
      const svg = await page.evaluate(
        async ({ key, source, family }) => {
          const mermaid = (
            window as unknown as {
              mermaid: {
                initialize(config: object): void;
                render(id: string, text: string): Promise<{ svg: string }>;
              };
            }
          ).mermaid;
          mermaid.initialize({ startOnLoad: false, theme: "neutral", fontFamily: family });
          return (await mermaid.render(key, source)).svg;
        },
        { key, source, family: DIAGRAM_FAMILY },
      );
      await writeFile(join(DIAGRAMS, `${key}.svg`), `${svg}\n`);
      console.log(`[docs] drew ${key}.svg`);
    }
  } finally {
    await browser.close();
  }
}
console.log(`[docs] ${wanted.size} diagrams, every one drawn`);
