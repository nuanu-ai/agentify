import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CopyRemediationPrompt } from "./copy-remediation-prompt";

describe("CopyRemediationPrompt", () => {
  it("renders a real button and no hidden prompt textarea by default", () => {
    const markup = renderToStaticMarkup(
      <CopyRemediationPrompt label="Copy this fix" prompt="Safe prompt" />,
    );
    expect(markup).toContain('type="button"');
    expect(markup).toContain("Copy this fix");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("textarea");
    expect(markup).not.toContain("Safe prompt");
  });

  it("offers an explicit markdown download when requested", () => {
    const markup = renderToStaticMarkup(
      <CopyRemediationPrompt
        allowDownload
        downloadUrl="/api/v1/reports/id/remediation-prompt/download"
        label="Copy complete implementation prompt"
        prompt="Safe prompt"
      />,
    );
    expect(markup).toContain("Download .md");
  });
});
