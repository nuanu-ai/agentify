/**
 * Search results and link previews describe the documentation page they lead
 * to. Editorial wording may change without changing that promise.
 */

import type { LoaderFunctionArgs } from "react-router";
import { describe, expect, it } from "vitest";
import { DOCS_DESCRIPTION, PAGES } from "./pages.js";
import { loader, meta } from "./routes/page.js";

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
