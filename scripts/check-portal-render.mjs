#!/usr/bin/env node

/**
 * Checks the documentation as the build wrote it to disk, after prerender:
 * every example and every program a page includes is shown whole on that
 * built page, every
 * built page carries the surface marker above the page, and no built page
 * carries a template escaped as `&lt;!--{{`, which Caddy cannot find. The
 * unit tests render the Markdown; only the built HTML shows what prerender
 * made of it. Whether an example passes its schema it leaves to
 * `packages/contracts/src/portal-fixtures.test.ts`.
 *
 * Run it after `pnpm --filter @agentify/docs build`. The built HTML, with tags
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
const PROGRAMS = join(PORTAL, "programs");
const DIST = join(PORTAL, "dist", "client");

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
    // The highlighter writes `<` and `&` in code as numeric references.
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
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

/** Every example and program file, by the path a page includes it with. */
const includableFiles = () =>
  [
    ...readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((directory) =>
        readdirSync(join(EXAMPLES, directory.name)).map(
          (name) => `examples/${directory.name}/${name}`,
        ),
      ),
    ...readdirSync(PROGRAMS).map((name) => `programs/${name}`),
  ].sort();

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
  die(`no built portal at ${DIST}; run "pnpm --filter @agentify/docs build" first`);
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

const files = includableFiles();
if (files.length === 0) die(`no example or program files under ${PORTAL}`);

const complaints = [];

for (const file of files) {
  const where = shownBy.get(file) ?? [];

  if (where.length === 0) {
    complaints.push(`apps/docs/${file} is included by no page, so no page can show it`);
    continue;
  }

  const wanted = readFileSync(join(PORTAL, file), "utf8").replace(/\s+/g, " ").trim();

  for (const html of where) {
    if (!built.includes(html)) {
      complaints.push(`${html} includes apps/docs/${file} and was never built`);
      continue;
    }

    const shown = textOf(readFileSync(join(DIST, html), "utf8"));

    if (shown.includes(wanted)) {
      console.log(`ok   ${html} shows apps/docs/${file}`);
      continue;
    }

    const printedAsText = /<<<\s+\S*(examples|programs)\//.test(shown);

    complaints.push(
      printedAsText
        ? `${html} printed the include line as text instead of the file: the build no longer understands "<<<", and every example on the site is gone`
        : `${html} does not show apps/docs/${file}; the page was built without it`,
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
  const main = html.indexOf('id="main"');
  return marker === -1 || main === -1 || marker > main;
});

if (unmarked.length > 0) {
  die(
    "these built pages carry no surface marker above the page, so a reader is told nothing " +
      `about which stack they are reading:\n  ${unmarked.join("\n  ")}`,
  );
}

// Caddy finds a template only by its comment-shaped delimiters. One written
// as `&lt;!--{{`, as React writes an attribute, would reach the reader
// unfilled, a channel's address shown as the template that names it.
const escaped = builtPages(DIST).filter((page) =>
  readFileSync(join(DIST, page), "utf8").includes("&lt;!--{{"),
);

if (escaped.length > 0) {
  die(`these built pages carry a template Caddy cannot find:\n  ${escaped.join("\n  ")}`);
}

console.log(`\n${files.length} example(s) and program(s) reached the pages that include them.`);
