import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TurnstileChallenge } from "./turnstile-challenge";

describe("TurnstileChallenge", () => {
  it("draws the challenge with the site key it is handed", () => {
    const html = renderToStaticMarkup(
      <TurnstileChallenge action="scan" siteKey="runtime-test-site-key" />,
    );

    expect(html).toContain('data-sitekey="runtime-test-site-key"');
  });

  it("draws no challenge where it is handed no site key", () => {
    const html = renderToStaticMarkup(
      <TurnstileChallenge action="report_recovery" siteKey={null} />,
    );

    expect(html).not.toContain("data-sitekey");
  });
});
