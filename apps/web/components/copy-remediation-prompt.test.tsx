import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CopyRemediationPrompt,
  gateStatusMessage,
} from "./copy-remediation-prompt";

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

  it("keeps gated public prompt actions modal-free", () => {
    const markup = renderToStaticMarkup(
      <CopyRemediationPrompt
        allowDownload
        contactGateScanId="019b41a0-7c51-7d63-84bd-a5a20faef497"
        downloadUrl="/api/v1/scans/id/remediation-prompt/download"
        label="Copy AI fix prompt"
        promptUrl="/api/v1/scans/id/remediation-prompt?scope=teaser"
      />,
    );
    expect(markup).toContain("Copy AI fix prompt");
    expect(markup).toContain("Download .md");
    expect(markup).not.toContain("<dialog");
    expect(markup).not.toContain("Confirm where to send access");
    expect(markup).not.toContain('type="email"');
  });

  it("explains the inline registration step when contact access is missing", () => {
    expect(gateStatusMessage("copy-prompt")).toBe(
      "Confirm your email in the highlighted form below — the prompt will be ready on your report.",
    );
    expect(gateStatusMessage("download-md")).toBe(
      "Confirm your email in the highlighted form below — the download starts right after verification.",
    );
  });
});
