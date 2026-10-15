import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DOCS_PAGES } from "@agentify/ui/docs";
import type { Config } from "@react-router/dev/config";
import { writeMarkdownCopies } from "./app/markdown-copy.js";
import { NOT_FOUND_PATH, SEARCH_INDEX_PATH } from "./app/pages.js";
import { withTemplatesRestored } from "./app/site-values.js";

/**
 * The documentation, drawn once at build time into static files that Caddy
 * serves under `/docs` with the prefix stripped.
 *
 * React Router writes a prerendered page under its whole address,
 * `dist/client/docs/money/index.html`, while Vite writes the scripts to
 * `dist/client/assets`, which the browser asks for as `/docs/assets/…`. The
 * build's last step therefore lifts the pages and their data files out of
 * `docs/` and writes each page as `money.html`, so one directory answers
 * both the way Caddy's block asks for them: a page as its address with
 * `.html`, its data as its address with `.data`. Every page is prerendered,
 * so the single-page fallback React Router writes is not needed and would
 * take the front page's place. A template React wrote into an attribute is
 * written back for Caddy to find, and beside each page goes its Markdown,
 * which Caddy answers a client that prefers Markdown with.
 */
export default {
  appDirectory: "app",
  buildDirectory: "dist",
  basename: "/docs/",
  ssr: false,
  prerender: [...DOCS_PAGES.map((page) => page.path), NOT_FOUND_PATH, SEARCH_INDEX_PATH],
  async buildEnd({ reactRouterConfig }) {
    const client = join(reactRouterConfig.buildDirectory, "client");
    await rm(join(client, "index.html"), { force: true });
    await rm(join(client, "__spa-fallback.html"), { force: true });
    const mounted = join(client, "docs");
    for (const entry of await readdir(mounted)) {
      await rename(join(mounted, entry), join(client, entry));
    }
    await rm(mounted, { recursive: true });
    // The index is a file, not a page; React Router writes data for it all the same.
    await rm(join(client, `${SEARCH_INDEX_PATH.slice(1)}.data`));
    // Deepest first, so `scanner/methodology/` is lifted before `scanner/`.
    const nested = [...DOCS_PAGES.map((page) => page.path), NOT_FOUND_PATH]
      .filter((path) => path !== "/")
      .sort((a, b) => b.length - a.length);
    for (const path of nested) {
      const directory = join(client, path);
      await rename(join(directory, "index.html"), `${directory}.html`);
      if ((await readdir(directory)).length === 0) await rm(directory, { recursive: true });
    }
    for (const entry of await readdir(client, { recursive: true })) {
      if (!entry.endsWith(".html")) continue;
      const file = join(client, entry);
      await writeFile(file, withTemplatesRestored(await readFile(file, "utf8")));
    }
    await writeMarkdownCopies(client);
  },
} satisfies Config;
