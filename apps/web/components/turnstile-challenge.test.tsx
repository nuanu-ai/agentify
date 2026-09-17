import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TurnstileChallenge } from "./turnstile-challenge";

describe("TurnstileChallenge", () => {
  it("renders a runtime-provided site key without exposing a build-time environment lookup", () => {
    const html = renderToStaticMarkup(
      <TurnstileChallenge action="scan" siteKey="runtime-test-site-key" />,
    );

    expect(html).toContain('data-sitekey="runtime-test-site-key"');
    expect(html).not.toContain("Challenge is not configured");
  });

  it("reports an unavailable challenge when runtime configuration has no site key", () => {
    const html = renderToStaticMarkup(
      <TurnstileChallenge action="report_recovery" siteKey={null} />,
    );

    expect(html).toContain("Challenge is not configured");
    expect(html).not.toContain("data-sitekey");
  });
});
