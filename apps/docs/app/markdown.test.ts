/**
 * What the pipeline promises a reader of the built pages: every link into
 * the documentation, from its own pages or from the scanner's and the
 * dashboard's, lands on a page it has and a heading that page carries, with
 * the anchors VitePress gave them; a writer's box keeps its title; and what a
 * deployment decides reaches the page as the template Caddy fills, while a
 * name the documentation does not know stops the build.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_PAGES } from "@agentify/ui/docs";
import { describe, expect, it } from "vitest";
import { parser, renderedPages, withSiteValues } from "./markdown.server.js";
import { UNLESS_END, unlessTemplate, valueTemplate } from "./site-values.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The page at a documentation address, `/docs/money` and `/docs/` alike. */
const pathOf = (address: string): string =>
  address.replace(/^\/docs/, "").replace(/\/$/, "") || "/";

const pages = await renderedPages();
const anchorsOf = (path: string): ReadonlySet<string> =>
  new Set(pages.get(path)?.headings.map((heading) => heading.id) ?? []);

/** Every `/docs/…` address written in the other surfaces' code a reader can follow. */
const linksFromTheSite = (): { where: string; address: string }[] =>
  [
    "apps/dashboard/app",
    "apps/dashboard/src",
    "apps/web/app",
    "apps/web/components",
    "apps/web/lib",
  ]
    .flatMap((directory) =>
      readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true })
        .filter(
          (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name),
        )
        .map((entry) => join(entry.parentPath, entry.name)),
    )
    .flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/["'`](\/docs\/[^"'`\s]*)["'`]/g)].map((found) => ({
        where: file.slice(ROOT.length),
        address: found[1] ?? "",
      })),
    );

describe("a link into the documentation", () => {
  it("from one of its pages lands on a page it has, at a heading that page carries", () => {
    const broken: string[] = [];
    for (const page of pages.values()) {
      for (const [, href = ""] of page.html.matchAll(/<a [^>]*href="([^"]*)"/g)) {
        const [address = "", anchor] = href.split("#");
        // A page links off the site, to the dashboard by its whole address,
        // and to nothing else on the origin outside the documentation.
        if (address.startsWith("/dashboard/") || /^[a-z]+:/.test(address)) continue;
        const target =
          address === "" ? page.path : address.startsWith("/docs") ? pathOf(address) : null;
        if (target === null) {
          broken.push(`${page.path} links to ${href}, which is outside the documentation`);
          continue;
        }
        if (!pages.has(target)) broken.push(`${page.path} links to ${href}, which is no page`);
        else if (anchor !== undefined && !anchorsOf(target).has(anchor)) {
          broken.push(`${page.path} links to ${href}, which ${target} has no heading for`);
        }
      }
    }

    expect(pages.size).toBe(DOCS_PAGES.length);
    expect(broken).toEqual([]);
  });

  it("from the dashboard's or the scanner's pages lands where it points", () => {
    const links = linksFromTheSite();
    const broken = links.filter(({ address }) => {
      const [path = "", anchor] = address.split("#");
      const target = pathOf(path);
      return !pages.has(target) || (anchor !== undefined && !anchorsOf(target).has(anchor));
    });

    expect(links.length).toBeGreaterThan(5);
    expect(broken).toEqual([]);
  });

  it("keeps the anchor VitePress gave a heading that starts with a digit", () => {
    expect(anchorsOf("/quickstart")).toContain("_1-make-the-merchant-account-ready");
  });
});

describe("a writer's box", () => {
  it("reaches the reader with its title", () => {
    const html = parser().render("::: warning The public surface is versioned\nText.\n:::\n");

    expect(html).toMatch(/class="[^"]*custom-block-title[^"]*">The public surface is versioned</);
    expect(html).toContain("<p>Text.</p>");
  });

  it("is kept off a channel inside an unless, as Caddy's template", () => {
    const html = parser().render(":::: unless identity-confirmed\n::: note\nNot yet.\n:::\n::::\n");

    expect(html.indexOf(unlessTemplate("identity-confirmed"))).toBeLessThan(
      html.indexOf("Not yet."),
    );
    expect(html.indexOf(UNLESS_END)).toBeGreaterThan(html.indexOf("Not yet."));
    expect(() => parser().render(":::: unless nothing-known\nx\n::::\n")).toThrow(/nothing-known/);
  });
});

describe("an include", () => {
  it("shows the whole file, and refuses a region it cannot cut", () => {
    expect(() => parser().render("<<< @/examples/card/access-monthly.json#region\n")).toThrow(
      /region or options/,
    );
    expect(parser().render("<<< @/examples/card/access-monthly.json\n")).toContain(
      "merchant_item_id",
    );
  });
});

describe("a site value", () => {
  it("reaches the page as the template Caddy fills, in text, code and a link's address", () => {
    const html = withSiteValues(
      parser().render(
        "Write to [{{abuse-email}}](mailto:{{abuse-email}}) at `{{origin}}/scanner`.\n",
      ),
    );

    expect(html).toContain(`href="mailto:${valueTemplate("abuse-email")}"`);
    expect(html).toContain(`>${valueTemplate("abuse-email")}</a>`);
    expect(html).toContain(`<code>${valueTemplate("origin")}/scanner</code>`);
  });

  it("is left as written inside a code block, which shows code", () => {
    const html = withSiteValues('<pre class="shiki"><code>{{nothing}}</code></pre>');

    expect(html).toContain("{{nothing}}");
  });

  it("the documentation does not know stops the build", () => {
    expect(() => withSiteValues("<p>{{nothing}}</p>")).toThrow(/\{\{nothing\}\}/);
  });
});
