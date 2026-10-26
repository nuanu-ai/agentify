import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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

describe("ReportActionPanel", () => {
  it("offers a link that downloads the .md again when a download intent resumes", () => {
    const markup = renderToStaticMarkup(
      <ReportActionPanel {...baseProps} initialIntent="download-md" />,
    );
    expect(markup).toMatch(/<a[^>]*download[^>]*>Download \.md again<\/a>/);
  });

  it("points a copy intent at the prompt button instead of a separate card", () => {
    const markup = renderToStaticMarkup(
      <ReportActionPanel {...baseProps} initialIntent="copy-prompt" />,
    );
    expect(markup).toContain("prompt is ready");
    expect(markup.match(/Copy AI fix prompt/g)).toHaveLength(1);
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
