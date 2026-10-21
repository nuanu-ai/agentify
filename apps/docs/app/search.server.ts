/**
 * The search index, built from the rendered pages cut into sections at their
 * headings: a section is a heading with what follows it up to the next
 * heading, and is titled by the headings above it. A page's title and its
 * introduction are found at the page's own address, every other section at
 * its heading's anchor.
 */

import { docsAddress } from "@agentify/ui/docs";
import MiniSearch from "minisearch";
import { renderedPages } from "./markdown.server.js";
import { SEARCH_OPTIONS } from "./search-options.js";
import { fillSiteValues } from "./site-values.js";

/**
 * What the index says where a page names what a deployment decides: one index
 * serves every channel and no Caddy fills it, so it names each value in words
 * rather than any channel's value, and leaves out what a channel may not show.
 */
const IN_WORDS = {
  origin: "this site",
  "abuse-email": "the abuse contact",
  operator: "the operator",
  "identity-confirmed": "true",
} as const;

/** A heading as the pipeline writes it: its level, its id and what it holds. */
const HEADING = /<h([1-6])\b[^>]*?\sid="([^"]*)"[^>]*>(.*?)<\/h\1>/gis;

/** What a reader sees of some HTML: its text, with the entities the pipeline writes read back. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&ZeroWidthSpace;", "")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();

type Section = Readonly<{ anchor: string; titles: string[]; text: string }>;

function* sectionsOf(html: string): Generator<Section> {
  const parts = html.split(HEADING);
  parts.shift();
  let parents: string[] = [];
  for (let at = 0; at < parts.length; at += 4) {
    const level = Number(parts[at]) - 1;
    const title = textOf(parts[at + 2] ?? "");
    const content = parts[at + 3];
    if (!title || !content) continue;
    const titles = parents.slice(0, level);
    titles[level] = title;
    yield {
      anchor: level === 0 ? "" : (parts[at + 1] ?? ""),
      titles: titles.filter(Boolean),
      text: textOf(content),
    };
    if (level === 0) parents = [title];
    else parents[level] = title;
  }
}

export async function searchIndex(): Promise<unknown> {
  const index = new MiniSearch(SEARCH_OPTIONS);
  for (const page of (await renderedPages()).values()) {
    const address = docsAddress(page.path);
    for (const { anchor, text, titles } of sectionsOf(fillSiteValues(page.html, IN_WORDS))) {
      index.add({
        id: anchor ? `${address}#${anchor}` : address,
        text,
        title: titles.at(-1),
        titles: titles.slice(0, -1),
      });
    }
  }
  return index.toJSON();
}
