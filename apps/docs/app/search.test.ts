/**
 * One search index serves every channel and no Caddy fills it, so it names
 * what a deployment decides in words rather than as a template a reader would
 * see stripped to nothing, and it holds nothing a channel may not show. A page
 * is found at its own address by its title and its introduction, and every
 * section of it names the page first in the path above it.
 */

import { docsAddress } from "@agentify/ui/docs";
import MiniSearch from "minisearch";
import { describe, expect, it } from "vitest";
import { renderedPages } from "./markdown.server.js";
import { searchIndex } from "./search.server.js";
import { SEARCH_OPTIONS, type SearchHit } from "./search-options.js";

const index = JSON.stringify(await searchIndex());
const pages = [...(await renderedPages()).values()];
const entries = new Map(
  MiniSearch.loadJSON(index, SEARCH_OPTIONS)
    .search(MiniSearch.wildcard)
    .map((hit) => [hit.id as string, hit as unknown as SearchHit]),
);

describe("the search index", () => {
  it("names the scanner's user agent and contacts in words", () => {
    expect(index).toContain("agentify-scanner/1.0 (+this site/scanner)");
    expect(index).toContain("Operator: the operator.");
    expect(index).not.toContain("<!--{{");
    expect(index).not.toContain("(+/scanner)");
  });

  it("holds no part a channel keeps off its pages", () => {
    expect(index).not.toContain("The final legal identity is not published yet.");
  });

  it("finds every page at its own address by its title and its introduction", () => {
    for (const page of pages) {
      const entry = entries.get(docsAddress(page.path));
      expect(entry?.title, page.path).toBe(page.title);
      expect(entry?.titles, page.path).toEqual([]);
      if (/<\/h1>\s*<p/.test(page.html)) expect(entry?.text, page.path).not.toBe("");
    }
  });

  it("names a section's page first in the path above it", () => {
    for (const page of pages) {
      const sections = [...entries.values()].filter((entry) =>
        entry.id.startsWith(`${docsAddress(page.path)}#`),
      );
      expect(sections.length, page.path).toBeGreaterThan(0);
      for (const section of sections) expect(section.titles[0], section.id).toBe(page.title);
    }
  });
});
