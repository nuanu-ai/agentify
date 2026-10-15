/**
 * A client that prefers Markdown is given each page's Markdown, which must
 * read on its own: every example a page includes written out whole, no
 * syntax only this pipeline understands, every link into the documentation
 * whole with the site's address, and what a deployment decides as the
 * templates Caddy fills.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { includedFile, includeOf } from "./includes.js";
import { sourceOf } from "./markdown.server.js";
import { markdownCopy } from "./markdown-copy.js";
import { PAGES } from "./pages.js";
import { UNLESS_END, unlessTemplate, valueTemplate } from "./site-values.js";

const copies = await Promise.all(
  PAGES.map(async (page) => {
    const source = await sourceOf(page);
    return { page, source, copy: await markdownCopy(source) };
  }),
);

describe("a page's Markdown", () => {
  it.each(copies)(
    "writes out whole every example $page.file includes",
    async ({ source, copy }) => {
      for (const line of source.split("\n")) {
        const named = includeOf(line.trim());
        if (named === undefined) continue;
        expect(copy).toContain((await readFile(includedFile(named), "utf8")).trim());
      }
    },
  );

  it.each(copies)("$page.file keeps none of the syntax only this pipeline reads", ({ copy }) => {
    const lines = copy.split("\n");
    expect(lines.filter((line) => /^\s*(<<<|:::)/.test(line))).toEqual([]);
    expect(lines.filter((line) => /^#.*\{#[\w-]+\}\s*$/.test(line))).toEqual([]);
    expect(copy).not.toMatch(/(?<!<!--)\{\{[a-z-]+\}\}/);
  });

  it.each(copies)("$page.file makes every link into the documentation whole", ({ copy }) => {
    expect(copy).not.toMatch(/\]\(\/[^)]*\)/);
  });

  it("names what a deployment decides as Caddy's templates", () => {
    const identity = copies.find(({ page }) => page.path === "/scanner")?.copy ?? "";

    expect(identity).toContain(`agentify-scanner/1.0 (+${valueTemplate("origin")}/scanner)`);
    expect(identity).toContain(`(mailto:${valueTemplate("abuse-email")})`);
    expect(identity.indexOf(unlessTemplate("identity-confirmed"))).toBeLessThan(
      identity.indexOf("The final legal identity is not published yet."),
    );
    expect(identity).toContain(UNLESS_END);
  });
});
