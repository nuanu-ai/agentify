import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicResultCard } from "./public-result-card";

describe("PublicResultCard", () => {
  it("renders only the public-safe score snapshot", () => {
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
    expect(markup).toContain("46");
    expect(markup).toContain('role="meter"');
  });
});
