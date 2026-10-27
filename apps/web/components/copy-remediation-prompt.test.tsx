// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyRemediationPrompt } from "./copy-remediation-prompt";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

  it("downloads the supplied Markdown URL when requested", async () => {
    const downloads: { href: string | null; download: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ href: this.getAttribute("href"), download: this.hasAttribute("download") });
    });
    render(
      <CopyRemediationPrompt
        allowDownload
        downloadUrl="/api/v1/reports/id/remediation-prompt/download"
        label="Copy complete implementation prompt"
        prompt="Safe prompt"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Download .md" }));
    expect(downloads).toEqual([
      { href: "/api/v1/reports/id/remediation-prompt/download", download: true },
    ]);
  });
});
