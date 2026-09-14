import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: () => undefined, push: () => undefined }),
}));

import { showSchemeHint, UrlScanForm } from "./url-scan-form";

describe("UrlScanForm scheme hint", () => {
  it("hints the assumed scheme only while the field is empty", () => {
    expect(showSchemeHint("")).toBe(true);
    expect(showSchemeHint("e")).toBe(false);
    expect(showSchemeHint("example.com")).toBe(false);
    expect(showSchemeHint("https://example.com")).toBe(false);
  });

  it("renders the hint next to the placeholder in the empty state", () => {
    const markup = renderToStaticMarkup(
      <UrlScanForm cta="Scan my site" segment="owner" variant="owner-v1" />,
    );
    expect(markup).toContain("https://");
    expect(markup).toContain('placeholder="yoursite.com"');
  });
});
