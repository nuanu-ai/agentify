/**
 * The search index, built from the rendered pages cut into sections at their
 * headings the way VitePress cuts them: a section is a heading with what
 * follows it up to the next heading, found by the anchor link every heading
 * carries, and is titled by the headings above it.
 */

import { docsAddress } from "@agentify/ui/docs";
import MiniSearch from "minisearch";
import { renderedPages } from "./markdown.server.js";
import { SEARCH_OPTIONS } from "./search-options.js";

const HEADING = /<h(\d*).*?>(.*?<a.*? href="#.*?".*?>.*?<\/a>)<\/h\1>/gi;
const HEADING_CONTENT = /(.*?)<a.*? href="#(.*?)".*?>.*?<\/a>/i;

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
  for (let at = 0; at < parts.length; at += 3) {
    const level = Number.parseInt(parts[at] ?? "", 10) - 1;
    const heading = HEADING_CONTENT.exec(parts[at + 1] ?? "");
    const title = textOf(heading?.[1] ?? "");
    const content = parts[at + 2];
    if (!title || !content) continue;
    const titles = parents.slice(0, level);
    titles[level] = title;
    yield { anchor: heading?.[2] ?? "", titles: titles.filter(Boolean), text: textOf(content) };
    if (level === 0) parents = [title];
    else parents[level] = title;
  }
}

export async function searchIndex(): Promise<unknown> {
  const index = new MiniSearch(SEARCH_OPTIONS);
  for (const page of (await renderedPages()).values()) {
    const address = docsAddress(page.path);
    for (const { anchor, text, titles } of sectionsOf(page.html)) {
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
