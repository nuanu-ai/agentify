import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ConsentPreferencesPanel } from "./consent-banner.js";
import { PrivacyChoicesButton } from "./privacy-choices-button.js";

describe("privacy choices reopen control", () => {
  it("renders an inline button instead of floating page chrome", () => {
    const markup = renderToStaticMarkup(
      <PrivacyChoicesButton className="footer-link" />,
    );
    expect(markup).toContain('type="button"');
    expect(markup).toContain("Privacy choices");
    expect(markup).toContain("footer-link");
  });
});

describe("consent preferences accessibility", () => {
  it("renders an explicitly labelled modal with independent unchecked options", () => {
    const markup = renderToStaticMarkup(
      <ConsentPreferencesPanel
        adsMeasurement={false}
        onAdsMeasurement={vi.fn()}
        onClose={vi.fn()}
        onProductAnalytics={vi.fn()}
        onSave={vi.fn()}
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
