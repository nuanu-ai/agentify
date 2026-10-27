/**
 * What the pipeline promises a reader of the built pages: every link into
 * the documentation, from its own pages or from the scanner's and the
 * dashboard's, lands on a page it has and a heading that page carries; a
 * writer's box keeps its title; and what a deployment decides reaches the
 * page as the template Caddy fills, while a name the documentation does not
 * know stops the build.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_GROUPS, DOCS_PAGES } from "@agentify/ui/docs";
import { PurchaseRequestSchema } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import scannerRoutes from "../../web/app/routes.js";
import { includedFile } from "./includes.js";
import { parser, renderedPages, sourceOf, withSiteValues } from "./markdown.server.js";
import { markdownCopy } from "./markdown-copy.js";
import { PAGES } from "./pages.js";
import { UNLESS_END, unlessTemplate, valueTemplate } from "./site-values.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The site's own address, as a page writes it and Caddy fills it. */
const ORIGIN = valueTemplate("origin");

/** The files the scanner answers at the site's root, such as `/llms.txt`, by its route table. */
const ROOT_FILES: ReadonlySet<string> = new Set(
  scannerRoutes.flatMap((entry) =>
    entry.path !== undefined && /^[^/:*]+\.[a-z]+$/.test(entry.path) ? [`/${entry.path}`] : [],
  ),
);

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
        // and on the origin outside the documentation to nothing but a file
        // the site serves at its root, by the site's own address, which is a
        // whole address once served. An address on the site's own is held as
        // any other.
        if (address.startsWith("/dashboard/") || /^[a-z]+:/.test(address)) continue;
        const onOrigin = address.startsWith(ORIGIN) ? address.slice(ORIGIN.length) : null;
        if (onOrigin !== null && ROOT_FILES.has(onOrigin)) continue;
        const within = onOrigin ?? address;
        const target =
          within === "" && onOrigin === null
            ? page.path
            : within.startsWith("/docs")
              ? pathOf(within)
              : null;
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

  it("gives a heading that starts with a digit an anchor starting with an underscore", () => {
    expect(parser().render("## 1. Purchase\n", { headings: [] })).toContain('id="_1-purchase"');
  });
});

describe("the release of the SDK the documentation describes", () => {
  const released = (
    JSON.parse(readFileSync(join(ROOT, "packages/sdk/package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const engineers = PAGES.filter((page) =>
    DOCS_GROUPS.find((group) => group.label === "For the engineer")?.entries.some(
      (entry) => entry.path === page.path && entry.section === undefined,
    ),
  );

  it("is named on every page for the engineer, as the package in the repository is versioned", async () => {
    expect(engineers.length).toBeGreaterThan(2);
    for (const page of engineers) {
      const named = `@nuanu-ai/agentify</code> ${released}`;

      expect(pages.get(page.path)?.html, page.path).toContain(named);
      expect(await markdownCopy(await sourceOf(page)), page.path).toContain(
        `\`@nuanu-ai/agentify\` ${released}`,
      );
    }
  });
});

describe("a writer's box", () => {
  it("reaches the reader with its title", () => {
    const html = parser().render("::: note The public surface is versioned\nText.\n:::\n");

    expect(html).toMatch(/class="[^"]*custom-block-title[^"]*">The public surface is versioned</);
    expect(html).toContain("<p>Text.</p>");
  });

  it("is kept off a channel inside an unless, as Caddy's template", () => {
    const html = parser().render(":::: unless identity-confirmed\n::: note\nNot yet.\n:::\n::::\n");

    const opener = html.indexOf(unlessTemplate("identity-confirmed"));
    const body = html.indexOf("Not yet.");
    expect(opener).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThan(opener);
    expect(html.indexOf(UNLESS_END)).toBeGreaterThan(body);
    expect(() => parser().render(":::: unless nothing-known\nx\n::::\n")).toThrow(/nothing-known/);
  });
});

describe("an include", () => {
  it("shows the whole file, and refuses a region it cannot cut", () => {
    expect(() => parser().render("<<< @/examples/card/access-monthly.json#region\n")).toThrow(
      /region or options/,
    );
    const named = "@/examples/card/access-monthly.json";
    const source = readFileSync(includedFile(named), "utf8");
    const md = parser();
    const html = md.render(`<<< ${named}\n`);
    expect(html.match(/<code[^>]*>([\s\S]*?)<\/code>/)?.[1]).toBe(md.utils.escapeHtml(source));
  });
});

describe("a value the build knows", () => {
  it("shows on the orders page a parcel's purchase with its address, as the purchase contract takes it", async () => {
    // The page is where a buyer's engineer learns the names of ship_to's
    // fields; a purchase written from a block the contract refused would fail.
    const orders = PAGES.find((page) => page.file === "orders.md");
    if (orders === undefined) throw new Error("no orders page");
    const blocks = [...(await sourceOf(orders)).matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map((found) => found[1] ?? "")
      .filter((block) => block.includes('"ship_to"'));

    expect(blocks).toHaveLength(1);
    expect(PurchaseRequestSchema.safeParse(JSON.parse(blocks[0] ?? "")).success).toBe(true);
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
