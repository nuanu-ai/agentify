// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberResumeIntent, takeResumeIntent } from "../lib/resume-intent";

import { ReportActionPanel } from "./report-action-panel";

const baseProps = {
  aiPrompt: "Complete prompt",
  devBrief: "Developer brief",
  downloadUrl: "/api/v1/reports/id/remediation-prompt/download",
  preview: { hostLabel: "example.com", level: "readable", score: 46 } as const,
  promptEnabled: true,
  scanId: "018f3f56-2ec8-7b16-8f66-5b8f93f3251f",
  shareEnabled: true,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "clipboard");
});
describe("ReportActionPanel", () => {
  it("downloads the supplied Markdown target once when its stored intent resumes", async () => {
    const downloads: { href: string | null; download: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push({ href: this.getAttribute("href"), download: this.hasAttribute("download") });
    });
    rememberResumeIntent(baseProps.scanId, "download-md");
    render(<ReportActionPanel {...baseProps} shareEnabled={false} />);
    await waitFor(() =>
      expect(downloads).toEqual([{ href: baseProps.downloadUrl, download: true }]),
    );
    expect(screen.getByRole("link", { name: /Download.*again/i }).getAttribute("href")).toBe(
      baseProps.downloadUrl,
    );
    expect(takeResumeIntent(baseProps.scanId)).toBeNull();
  });
  it("resumes a stored copy intent at the button that copies the complete prompt", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    rememberResumeIntent(baseProps.scanId, "copy-prompt");
    render(<ReportActionPanel {...baseProps} shareEnabled={false} />);
    await screen.findByText(/prompt is ready/i);
    await userEvent.click(screen.getByRole("button", { name: "Copy AI fix prompt" }));
    expect(copied).toEqual(["Complete prompt"]);
    expect(takeResumeIntent(baseProps.scanId)).toBeNull();
  });

  it.each([
    ["sharing and prompts are both off", { shareEnabled: false, promptEnabled: false }],
    [
      "sharing is on but the scan has no score to share",
      { promptEnabled: false, preview: { ...baseProps.preview, score: null } },
    ],
  ])("draws no panel when %s", (_case, overrides) => {
    expect(renderToStaticMarkup(<ReportActionPanel {...baseProps} {...overrides} />)).toBe("");
  });

  it("says before either share button is pressed that both publish a link that can be revoked", () => {
    const markup = renderToStaticMarkup(<ReportActionPanel {...baseProps} />);

    expect(markup).toMatch(/<button[^>]*>[^<]*publish[^<]*image[^<]*<\/button>/i);
    // The note sits under four or five buttons, so it names the two it means.
    const note = markup.match(/<p[^>]*>([^<]*revoke[^<]*)<\/p>/i)?.[1] ?? "";
    expect(note).toContain("Copy share link");
    expect(note).toContain("Publish image");
  });

  it("drops prompt actions when the export flag is off", () => {
    const markup = renderToStaticMarkup(<ReportActionPanel {...baseProps} promptEnabled={false} />);
    expect(markup).toContain("Copy share link");
    expect(markup).not.toContain("Copy AI fix prompt");
    expect(markup).not.toContain("Download .md");
  });
});
