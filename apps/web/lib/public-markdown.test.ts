import { afterEach, describe, expect, it } from "vitest";

import { PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";
import { getPublicPageMarkdown } from "./public-markdown";

const originalBaseUrl = process.env.NEXT_PUBLIC_APP_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined)
    delete process.env.NEXT_PUBLIC_APP_BASE_URL;
  else process.env.NEXT_PUBLIC_APP_BASE_URL = originalBaseUrl;
});

describe("public Markdown variants", () => {
  it("renders substantive canonical content for every public route", () => {
    process.env.NEXT_PUBLIC_APP_BASE_URL = "https://agentify.ad";
    for (const path of PUBLIC_PAGE_PATHS) {
      const markdown = getPublicPageMarkdown(path);
      expect(markdown).toMatch(/^#\s+\S+/);
      expect(markdown).toMatch(/^##\s+\S+/m);
      expect(markdown.length).toBeGreaterThan(500);
      expect(markdown).not.toContain("undefined");
    }
  });

  it("keeps the methodology rubric and landing source links in parity", () => {
    const methodology = getPublicPageMarkdown("/methodology");
    const owner = getPublicPageMarkdown("/owner");

    expect(methodology.match(/^- `#\d+`/gm)).toHaveLength(18);
    expect(owner).toContain("Pew Research Center");
    expect(owner).toContain("How the scan works");
    expect(owner).toContain("Common questions");
  });
});
