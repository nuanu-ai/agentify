/**
 * Search results and link previews describe the documentation page they lead
 * to, and a page tells a reader that prefers Markdown where its Markdown is.
 * Editorial wording may change without changing that promise.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoaderFunctionArgs, MetaDescriptor } from "react-router";
import { afterAll, describe, expect, it } from "vitest";
import { writeMarkdownCopies } from "./markdown-copy.js";
import { DOCS_DESCRIPTION, PAGES } from "./pages.js";
import { loader, meta } from "./routes/page.js";
import { valueTemplate } from "./site-values.js";

/** The head a page is served with, outside a deployment, so the site's address is Caddy's template. */
const headOfPage = async (path: string): Promise<MetaDescriptor[]> =>
  meta({
    loaderData: await loader({ params: { "*": path.slice(1) } } as unknown as LoaderFunctionArgs),
    matches: [],
  } as unknown as Parameters<typeof meta>[0]);

/** A tag's fields, read as plain data. */
const fieldsOf = (tag: MetaDescriptor): Readonly<Record<string, unknown>> =>
  tag as Readonly<Record<string, unknown>>;

const contentOf = (tags: MetaDescriptor[], named: string): unknown =>
  tags.map(fieldsOf).find((tag) => tag.property === named || tag.name === named)?.content;

describe("documentation search metadata", () => {
  it("describes every page individually in search results and link previews", async () => {
    const descriptions: string[] = [];
    const titles: string[] = [];
    for (const page of PAGES) {
      const loaderData = await loader({
        params: { "*": page.path.slice(1) },
      } as unknown as LoaderFunctionArgs);
      const tags = meta({
        loaderData,
        matches: [],
      } as unknown as Parameters<typeof meta>[0]);
      const description = tags.find((tag) => "name" in tag && tag.name === "description");
      const title = tags.find((tag) => "title" in tag);
      expect(description, page.path).toHaveProperty("content");
      if (description === undefined || !("content" in description)) continue;
      const text = String(description.content);
      expect(text.trim(), page.path).toBeTruthy();
      expect(text, page.path).not.toBe(DOCS_DESCRIPTION);
      expect(tags, page.path).toContainEqual({ property: "og:description", content: text });
      expect(tags, page.path).toContainEqual({ name: "twitter:description", content: text });
      expect(title, page.path).toHaveProperty("title");
      descriptions.push(text);
      if (title !== undefined && "title" in title) {
        expect(typeof title.title, page.path).toBe("string");
        if (typeof title.title === "string") titles.push(title.title);
      }
    }
    expect(new Set(descriptions).size).toBe(PAGES.length);
    expect(new Set(titles).size).toBe(PAGES.length);
  });
});

describe("a page's Markdown", () => {
  const built = mkdtempSync(join(tmpdir(), "agentify-docs-markdown-"));
  afterAll(() => rmSync(built, { recursive: true, force: true }));

  it("is named in every page's head at an address the build writes it to", async () => {
    await writeMarkdownCopies(built);
    const origin = `${valueTemplate("origin")}/docs/`;

    for (const page of PAGES) {
      const named = (await headOfPage(page.path))
        .map(fieldsOf)
        .find((tag) => tag.rel === "alternate" && tag.type === "text/markdown");
      const href = String(named?.href ?? "");

      expect(href.startsWith(origin), `${page.path}: ${href}`).toBe(true);
      expect(existsSync(join(built, href.slice(origin.length))), `${page.path}: ${href}`).toBe(
        true,
      );
    }
  });
});

describe("a link to a page, unfurled", () => {
  it("shows the picture about selling to agents for a merchant page, and the site's for a scanner page", async () => {
    for (const page of PAGES) {
      const tags = await headOfPage(page.path);
      const picture = String(contentOf(tags, "og:image"));

      expect(contentOf(tags, "twitter:card"), page.path).toBe("summary_large_image");
      expect(picture, page.path).toBe(
        `${valueTemplate("origin")}${page.site === true ? "/opengraph-image" : "/agentic-shop/opengraph-image"}`,
      );
      expect(contentOf(tags, "og:image:alt"), page.path).toBeTruthy();
    }
  });
});
