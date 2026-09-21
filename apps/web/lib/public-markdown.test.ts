import { afterEach, describe, expect, it } from "vitest";

import { PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";
import { getPublicPageMarkdown } from "./public-markdown";

const originalBaseUrl = process.env.APP_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalBaseUrl;
});

describe("public Markdown variants", () => {
  it("renders substantive canonical content for every public route", () => {
    process.env.APP_BASE_URL = "https://agentify.ad";
    for (const path of PUBLIC_PAGE_PATHS) {
      const markdown = getPublicPageMarkdown(path);
      expect(markdown).toMatch(/^#\s+\S+/);
      expect(markdown).toMatch(/^##\s+\S+/m);
      expect(markdown.length).toBeGreaterThan(500);
      expect(markdown).not.toContain("undefined");
    }
  });

  it("keeps the methodology rubric and the landing sections in parity, and hands an agent the second door", () => {
    process.env.APP_BASE_URL = "https://agentify.ad";
    const methodology = getPublicPageMarkdown("/methodology");
    const owner = getPublicPageMarkdown("/");
    const front = owner;

    expect(methodology.match(/^- `#\d+`/gm)).toHaveLength(18);
    expect(owner).toContain("How the scan works");
    expect(owner).toContain("What you get back");
    expect(front).toContain("](https://agentify.ad/agentic-shop)");
  });
});
