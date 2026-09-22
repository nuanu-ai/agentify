import { describe, expect, it } from "vitest";

import { extractRawMetadata, rawTextCharacterCount } from "./browser-signals.js";

describe("browser signal extraction", () => {
  it("counts useful raw text without scripts and styles", () => {
    const html = `
      <html><head><style>.x { display:none }</style></head>
      <body><h1>Useful title</h1><script>secret text</script><p>Hello &amp; world</p></body></html>
    `;
    expect(rawTextCharacterCount(html)).toBe("Useful title Hello & world".length);
  });

  it("extracts only aggregate metadata and structured facts", () => {
    const result = extractRawMetadata(
      `
        <link rel="canonical" href="/products/widget?campaign=private">
        <link rel="alternate" hreflang="en" href="/en">
        <script type="application/ld+json">
          {"@type":"Product","offers":{"price":"10","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
        </script>
      `,
      "https://example.com/source",
    );
    expect(result).toEqual({
      canonical: "https://example.com/products/widget",
      hreflangCount: 1,
      jsonLdCount: 1,
      currencies: ["USD"],
      availability: ["instock"],
      priceCount: 1,
      hasContact: false,
      hasOpeningHours: false,
    });
  });
});
