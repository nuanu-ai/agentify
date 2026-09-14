import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicResultCard } from "./public-result-card";

describe("PublicResultCard", () => {
  it("renders only the public-safe score snapshot and all scale labels", () => {
    const markup = renderToStaticMarkup(
      <PublicResultCard
        preview={{
          hostLabel: "example.com",
          level: "readable",
          score: 46,
          scannedLabel: "Scanned Jul 14, 2026",
        }}
      />,
    );

    expect(markup).toContain("example.com");
    expect(markup).toContain("Readable");
    expect(markup).toContain("46");
    expect(markup).toContain("Invisible");
    expect(markup).toContain("Callable-ready");
    expect(markup).toContain("Ahead of the market");
    expect(markup).toContain('role="meter"');
    expect(markup).toContain('data-agentify-mark="standard"');
    expect(markup).toContain(
      "Detailed findings and contact details stay private",
    );
  });
});
