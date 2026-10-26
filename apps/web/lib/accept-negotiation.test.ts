import { describe, expect, it } from "vitest";

import { appendVary, isPrefetch, prefersMarkdown } from "./accept-negotiation";

describe("Markdown Accept negotiation", () => {
  it.each([
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/html, text/markdown;q=0.5", false],
    ["text/markdown;q=0, text/html", false],
    ["text/markdown; charset=utf-8", true],
    ["text/markdown; charset=utf-8; q=0", false],
    ["text/markdown;q=0;charset=utf-8", false],
    ["text/html; charset=utf-8, text/markdown", false],
    ["text/*", false],
    ["*/*", false],
    [null, false],
  ])("handles %s", (header, expected) => {
    expect(prefersMarkdown(header)).toBe(expected);
  });

  it("preserves existing Vary tokens without duplicates", () => {
    expect(appendVary("Origin, Cookie", "Accept")).toBe("Origin, Cookie, Accept");
    expect(appendVary("Accept", "accept")).toBe("accept");
  });

  it("tells a prefetch from a visit", () => {
    expect(isPrefetch(new Headers({ purpose: "prefetch" }))).toBe(true);
    expect(isPrefetch(new Headers({ purpose: "Prefetch" }))).toBe(true);
    expect(isPrefetch(new Headers())).toBe(false);
  });
});
