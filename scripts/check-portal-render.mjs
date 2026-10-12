#!/usr/bin/env node

/**
 * Checks that the portal's examples reached the built pages.
 *
 * `packages/contracts/src/portal-fixtures.test.ts` holds each example to its
 * schema and to the pages that name it. No test can see whether VitePress
 * turned `<<< @/examples/…` into the file's content or printed the line as
 * text: a snippet syntax changed by an upgrade would leave the suite green
 * while every example vanished from the site.
 *
 * Run it after `pnpm run docs:build` in `apps/docs/`. The built HTML, with tags
 * removed and entities decoded, must contain the example's whole text.
 * Whitespace is collapsed on both sides because the highlighter lays the JSON
 * out in spans.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PORTAL = join(ROOT, "apps", "docs");
const EXAMPLES = join(PORTAL, "examples");
const DIST = join(PORTAL, ".vitepress", "dist");

/** The house style for writers; the site does not build it. */
const NOT_A_PAGE = "WRITING.md";

const die = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

/**
 * What a reader sees. A tag becomes nothing rather than a space: the
 * highlighter puts every JSON token in its own span with no whitespace between
 * them, so a space would split `"merchant_item_id":` and no example would match.
 */
const textOf = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // Last, so that a page writing `&amp;lt;` keeps its `&lt;` instead of
    // turning into a `<` it never wrote.
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** The paths a page includes: `<<< @/examples/card/x.json`, region and options cut. */
const includesOf = (markdown) =>
  markdown
    .split("\n")
    .map((line) => /^<<<\s+(\S+)/.exec(line.trim())?.[1])
    .filter((path) => path !== undefined)
    .map((path) => path.replace(/[#{].*$/, "").replace(/^@\//, ""));

/** Every example file, by the path a page includes it with. */
const exampleFiles = () =>
  readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((directory) =>
      readdirSync(join(EXAMPLES, directory.name)).map((name) => `${directory.name}/${name}`),
    )
    .sort();

const builtPages = (directory, prefix = "") =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? builtPages(join(directory, entry.name), `${prefix}${entry.name}/`)
      : entry.name.endsWith(".html")
        ? [`${prefix}${entry.name}`]
        : [],
  );

let built;
try {
  built = builtPages(DIST);
} catch {
  die(`no built portal at ${DIST}; run "pnpm run docs:build" in apps/docs/ first`);
}

/** Which pages name each example, and the built page each of those became. */
const pages = readdirSync(PORTAL)
  .filter((name) => name.endsWith(".md") && name !== NOT_A_PAGE)
  .sort();

const shownBy = new Map();
for (const page of pages) {
  const html = `${basename(page, ".md")}.html`;

  for (const path of includesOf(readFileSync(join(PORTAL, page), "utf8"))) {
    shownBy.set(path, [...(shownBy.get(path) ?? []), html]);
  }
}

if (shownBy.size === 0) {
  // The negative control: a moved portal or an unrecognised include syntax
  // would otherwise leave nothing to check and report success.
  die(`no page under ${PORTAL} includes anything; the layout or the syntax has changed`);
}

const files = exampleFiles();
if (files.length === 0) die(`no example files under ${EXAMPLES}`);

const complaints = [];

for (const file of files) {
  const where = shownBy.get(`examples/${file}`) ?? [];

  if (where.length === 0) {
    complaints.push(`apps/docs/examples/${file} is included by no page, so no page can show it`);
    continue;
  }

  const wanted = readFileSync(join(EXAMPLES, file), "utf8").replace(/\s+/g, " ").trim();

  for (const html of where) {
    if (!built.includes(html)) {
      complaints.push(`${html} includes apps/docs/examples/${file} and was never built`);
      continue;
    }

    const shown = textOf(readFileSync(join(DIST, html), "utf8"));

    if (shown.includes(wanted)) {
      console.log(`ok   ${html} shows apps/docs/examples/${file}`);
      continue;
    }

    const printedAsText = /<<<\s+\S*examples\//.test(shown);

    complaints.push(
      printedAsText
        ? `${html} printed the include line as text instead of the file: VitePress no longer understands "<<<", and every example on the site is gone`
        : `${html} does not show apps/docs/examples/${file}; the page was built without it`,
    );
  }
}

if (complaints.length > 0) {
  // Deduplicated: when the syntax itself is gone, every example on a page has
  // the same complaint.
  die(`the built portal does not show its examples:\n  ${[...new Set(complaints)].join("\n  ")}`);
}

// Every built page, nested ones included, carries the surface marker above the
// page. The release probe fetches only three addresses, and a marker appended
// at the end would satisfy it while reaching no reader.
const unmarked = builtPages(DIST).filter((page) => {
  const html = readFileSync(join(DIST, page), "utf8");
  const marker = html.indexOf('data-agentify-surface="');
  const app = html.indexOf('<div id="app"');
  return marker === -1 || app === -1 || marker > app;
});

if (unmarked.length > 0) {
  die(
    "these built pages carry no surface marker above the page, so a reader is told nothing " +
      `about which stack they are reading:\n  ${unmarked.join("\n  ")}`,
  );
}

console.log(`\n${files.length} example(s) reached the pages that include them.`);
