import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConsentPreferencesPanel } from "./consent-banner.js";

describe("consent preferences accessibility", () => {
  it("renders an explicitly labelled modal with independent unchecked options", () => {
    const markup = renderToStaticMarkup(
      <ConsentPreferencesPanel
        adsMeasurement={false}
        onAdsMeasurement={() => undefined}
        onClose={() => undefined}
        onProductAnalytics={() => undefined}
        onSave={() => undefined}
        productAnalytics={false}
        saving={false}
      />,
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-labelledby="consent-title"');
    expect(markup).toContain("Product analytics");
    expect(markup).toContain("Ads measurement");
    expect(markup.match(/type="checkbox"/g)).toHaveLength(3);
    expect(markup.match(/checked=""/g)).toHaveLength(1);
  });
});
