/**
 * The Markdown a client that prefers it is answered with, one file beside
 * each built page. It is the page's source made readable on its own: each
 * included example written out as a code block, each box a quotation under
 * its title, a heading without its `{#id}`, a link into the documentation
 * made whole with the site's address, and every site value as the template
 * Caddy fills when it serves the file, as it fills the page. A diagram stays
 * the Mermaid source it is drawn from.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { includedFile, includeOf } from "./includes.js";
import { sourceOf } from "./markdown.server.js";
import { PAGES } from "./pages.js";
import { isSiteValueName, UNLESS_END, unlessTemplate, valueTemplate } from "./site-values.js";

/** Where a page's Markdown is written in the build: `/money` as `money.md`, the front page as `index.md`. */
const markdownFileOf = (path: string): string =>
  path === "/" ? "index.md" : `${path.slice(1)}.md`;

const OPENER = /^(:{3,})\s*(\S+)(?:\s+(.*))?$/;
const CLOSER = /^(:{3,})\s*$/;
const FENCE = /^(`{3,}|~{3,})/;

const siteValues = (line: string): string =>
  line.replace(/(?<!<!--)\{\{([a-z-]+)\}\}/g, (_whole, name: string) => {
    if (!isSiteValueName(name)) throw new Error(`{{${name}}} names no site value`);
    return valueTemplate(name);
  });

const wholeLinks = (line: string): string =>
  line.replace(/\]\((\/[^)\s]*)\)/g, (_whole, href: string) => {
    return `](${valueTemplate("origin")}/docs${href === "/" ? "/" : href})`;
  });

/** One page's source, as the Markdown a reader of Markdown is given. */
export async function markdownCopy(source: string): Promise<string> {
  const out: string[] = [];
  const open: { marker: string; quoted: boolean }[] = [];
  let fence: string | undefined;
  const quote = (line: string): string => {
    const depth = open.filter((each) => each.quoted).length;
    return depth === 0 ? line : `${"> ".repeat(depth)}${line}`.trimEnd();
  };
  for (const line of source.split("\n")) {
    if (fence !== undefined) {
      out.push(quote(line));
      if (line.trim().startsWith(fence)) fence = undefined;
      continue;
    }
    const opensFence = FENCE.exec(line.trim());
    if (opensFence !== null) {
      fence = opensFence[1]?.[0]?.repeat(3) ?? "```";
      out.push(quote(line));
      continue;
    }
    const included = includeOf(line.trim());
    if (included !== undefined) {
      const file = includedFile(included);
      const text = (await readFile(file, "utf8")).replace(/\n$/, "");
      for (const each of [`\`\`\`${extname(file).slice(1)}`, ...text.split("\n"), "```"]) {
        out.push(quote(each));
      }
      continue;
    }
    const closes = CLOSER.exec(line.trim());
    if (closes !== null && open.at(-1)?.marker === closes[1]) {
      const closed = open.pop();
      out.push(closed?.quoted === false ? UNLESS_END : "");
      continue;
    }
    const opens = OPENER.exec(line.trim());
    if (opens !== null) {
      const [, marker = ":::", kind = "", title] = opens;
      if (kind === "unless") {
        const name = (title ?? "").trim();
        if (!isSiteValueName(name)) throw new Error(`"unless ${name}" names no site value`);
        out.push(unlessTemplate(name));
        open.push({ marker, quoted: false });
      } else {
        open.push({ marker, quoted: true });
        const heading = title ?? (kind === "note" ? "" : kind.toUpperCase());
        if (heading !== "") out.push(quote(`**${siteValues(heading)}**`), quote(""));
      }
      continue;
    }
    const heading = /^(#{1,6}\s.*?)\s*\{#[\w-]+\}\s*$/.exec(line)?.[1];
    out.push(quote(siteValues(wholeLinks(heading ?? line))));
  }
  return out.join("\n");
}

/** Writes every page's Markdown beside its built page in `client`. */
export async function writeMarkdownCopies(client: string): Promise<void> {
  for (const page of PAGES) {
    const written = join(client, markdownFileOf(page.path));
    await mkdir(dirname(written), { recursive: true });
    await writeFile(written, await markdownCopy(await sourceOf(page)));
  }
}
