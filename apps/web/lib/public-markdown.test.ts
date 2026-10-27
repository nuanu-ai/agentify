import { afterEach, describe, expect, it } from "vitest";

import { AGENTIC_SHOP } from "../content/agentic-shop";
import { LANDING_SHARED_CONTENT, LANDINGS } from "../content/landing";
import { getPublicEditorialPage } from "../content/public-editorial";
import { KEPT_PAGE_PATHS } from "../content/public-page-metadata";
import { getPublicAppConfig } from "./app-config";
import { getPublicPageMarkdown } from "./public-markdown";

const originalBaseUrl = process.env.APP_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalBaseUrl;
});

describe("public Markdown variants", () => {
  it("renders structured canonical content for every public route", () => {
    process.env.APP_BASE_URL = "https://agentify.ad";
    expect(KEPT_PAGE_PATHS.length).toBeGreaterThan(0);
    for (const path of KEPT_PAGE_PATHS) {
      const markdown = getPublicPageMarkdown(path);
      expect(markdown).toMatch(/^#\s+\S+/);
      expect(markdown).toMatch(/^##\s+\S+/m);
      expect(markdown).not.toContain("undefined");
      const landing =
        path === "/"
          ? LANDINGS.owner
          : path === "/store"
            ? LANDINGS.store
            : path === "/local"
              ? LANDINGS.local
              : null;
      if (landing) {
        expect(markdown).toContain(landing.hero.subtitle);
        for (const step of LANDING_SHARED_CONTENT.howSteps) expect(markdown).toContain(step.body);
        expect(markdown).toContain("https://agentify.ad/docs/scanner/methodology");
      } else if (path === "/agentic-shop") {
        expect(markdown).toContain(AGENTIC_SHOP.hero.description);
        expect(markdown).toContain(AGENTIC_SHOP.opportunity.research.sourceUrl);
        expect(markdown).toContain("https://agentify.ad/dashboard/sign-in");
      } else if (path === "/privacy" || path === "/terms") {
        const page = getPublicEditorialPage(path, getPublicAppConfig());
        expect(page.intro.trim()).not.toBe("");
        expect(markdown).toContain(page.intro);
        expect(page.sections.length).toBeGreaterThan(0);
        for (const section of page.sections) expect(markdown).toContain(section.title);
      }
    }
  });

  it("keeps the merchant route and the way to the methodology in the agent variant", () => {
    process.env.APP_BASE_URL = "https://agentify.ad";
    const front = getPublicPageMarkdown("/");

    expect(front).toContain("](https://agentify.ad/agentic-shop)");
    expect(front).toContain("](https://agentify.ad/docs/scanner/methodology)");
  });

  it.each(["/", "/store", "/local"] as const)(
    "leads an agent that buys from %s to where it starts, by its whole address",
    (path) => {
      process.env.APP_BASE_URL = "https://agentify.ad";

      expect(getPublicPageMarkdown(path)).toContain("](https://agentify.ad/llms.txt)");
    },
  );
});
