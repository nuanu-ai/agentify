import { describe, expect, it } from "vitest";

import { selectRepresentativeUrls } from "./representative-pages.js";

describe("representative page discovery", () => {
  it("selects at most two deterministic, same-site, query-free content pages", () => {
    const selected = selectRepresentativeUrls({
      baseUrl: "https://www.example.com/",
      allowedDomain: "example.com",
      rawUrls: [
        "https://evil.example.net/products/private",
        "https://www.example.com/checkout",
        "https://www.example.com/products/widget?session=secret",
        "https://www.example.com/assets/catalog.pdf",
        "https://shop.example.com/products/widget",
        "https://www.example.com/services/consulting",
        "https://www.example.com/about",
        "https://www.example.com/services/consulting",
      ],
    });

    expect(selected.map(String)).toEqual([
      "https://shop.example.com/products/widget",
      "https://www.example.com/services/consulting",
    ]);
  });

  it("rejects unsafe schemes, ports, credentials and the base page", () => {
    const selected = selectRepresentativeUrls({
      baseUrl: "https://example.com/owner",
      allowedDomain: "example.com",
      rawUrls: [
        "https://example.com/owner",
        "https://user:secret@example.com/products/one",
        "https://example.com:8443/products/two",
        "http://example.com/products/downgrade",
        "file:///etc/passwd",
        "https://example.com/products/three#details",
      ],
    });
    expect(selected).toEqual([]);
  });
});
