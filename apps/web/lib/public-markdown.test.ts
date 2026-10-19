import { afterEach, describe, expect, it } from "vitest";

import { KEPT_PAGE_PATHS } from "../content/public-page-metadata";
import { getPublicPageMarkdown } from "./public-markdown";

const originalBaseUrl = process.env.APP_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalBaseUrl;
});

describe("public Markdown variants", () => {
  it("renders structured canonical content for every public route", () => {
    process.env.APP_BASE_URL = "https://agentify.ad";
    for (const path of KEPT_PAGE_PATHS) {
      const markdown = getPublicPageMarkdown(path);
      expect(markdown).toMatch(/^#\s+\S+/);
      expect(markdown).toMatch(/^##\s+\S+/m);
      expect(markdown).not.toContain("undefined");
    }
  });

  it("keeps the merchant route and the way to the methodology in the agent variant", () => {
    process.env.APP_BASE_URL = "https://agentify.ad";
    const front = getPublicPageMarkdown("/");

    expect(front).toContain("](https://agentify.ad/agentic-shop)");
    expect(front).toContain("](https://agentify.ad/docs/scanner/methodology)");
  });
});
