import { afterEach, describe, expect, it } from "vitest";

import { PUBLIC_PAGE_PATHS } from "../content/public-page-metadata";
import { getPublicPageMarkdown } from "./public-markdown";

const originalBaseUrl = process.env.APP_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalBaseUrl;
});

describe("public Markdown variants", () => {
  it("renders structured canonical content for every public route", () => {
    process.env.APP_BASE_URL = "https://agentify.ad";
    for (const path of PUBLIC_PAGE_PATHS) {
      const markdown = getPublicPageMarkdown(path);
      expect(markdown).toMatch(/^#\s+\S+/);
      expect(markdown).toMatch(/^##\s+\S+/m);
      expect(markdown).not.toContain("undefined");
    }
  });

  it("keeps the methodology rubric and merchant route in the agent variant", () => {
    process.env.APP_BASE_URL = "https://agentify.ad";
    const methodology = getPublicPageMarkdown("/methodology");
    const front = getPublicPageMarkdown("/");

    expect(methodology.match(/^- `#\d+`/gm)).toHaveLength(18);
    expect(front).toContain("](https://agentify.ad/agentic-shop)");
  });
});
