import { afterEach, describe, expect, it } from "vitest";

import {
  PUBLIC_PAGE_METADATA,
  PUBLIC_PAGE_PATHS,
} from "../content/public-page-metadata";
import sitemap from "./sitemap";

const originalBaseUrl = process.env.NEXT_PUBLIC_APP_BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined)
    delete process.env.NEXT_PUBLIC_APP_BASE_URL;
  else process.env.NEXT_PUBLIC_APP_BASE_URL = originalBaseUrl;
});

describe("sitemap", () => {
  it("contains exactly the public canonical allowlist with honest dates", () => {
    process.env.NEXT_PUBLIC_APP_BASE_URL = "https://agentify.ad";
    const entries = sitemap();
    const now = Date.now();

    expect(entries).toHaveLength(PUBLIC_PAGE_PATHS.length + 1);
    expect(new Set(entries.map((entry) => entry.url)).size).toBe(
      PUBLIC_PAGE_PATHS.length + 1,
    );
    expect(entries.map((entry) => entry.url)).toEqual([
      ...PUBLIC_PAGE_PATHS.map((path) => `https://agentify.ad${path}`),
      "https://agentify.ad/agentic-shop",
    ]);
    for (const path of PUBLIC_PAGE_PATHS) {
      const metadata = PUBLIC_PAGE_METADATA[path];
      expect(Number.isNaN(Date.parse(metadata.lastModified))).toBe(false);
      expect(Date.parse(metadata.lastModified)).toBeLessThanOrEqual(now);
    }
  });
});
