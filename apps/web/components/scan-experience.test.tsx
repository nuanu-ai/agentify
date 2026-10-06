import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ScanExperience } from "./scan-experience";

describe("ScanExperience teaser actions", () => {
  it("offers a readable teaser prompt download and scan-token share preview", () => {
    const markup = renderToStaticMarkup(
      <ScanExperience
        browserObservationsEnabled={false}
        fixture="teaser"
        publicShareEnabled
        registrationEnabled
        remediationPromptEnabled
        scanId="018f3f56-2ec8-7b16-8f66-5b8f93f3251f"
        segment="owner"
      />,
    );

    expect(markup).toContain("Copy AI fix prompt");
    expect(markup).toContain("Download .md");
    expect(markup).toContain("Copy share link");
  });

  it("hides unusable teaser export actions when registration is disabled", () => {
    const markup = renderToStaticMarkup(
      <ScanExperience
        browserObservationsEnabled={false}
        fixture="teaser"
        publicShareEnabled
        registrationEnabled={false}
        remediationPromptEnabled
        scanId="018f3f56-2ec8-7b16-8f66-5b8f93f3251f"
        segment="owner"
      />,
    );
    expect(markup).not.toContain("Copy AI fix prompt");
    expect(markup).not.toContain("Download .md");
    expect(markup).toContain("Copy share link");
  });

  it("tells the owner which checks their robots.txt kept the scanner from", () => {
    const render = (fixture: string) =>
      renderToStaticMarkup(
        <ScanExperience
          browserObservationsEnabled={false}
          fixture={fixture}
          publicShareEnabled
          registrationEnabled
          remediationPromptEnabled
          scanId="018f3f56-2ec8-7b16-8f66-5b8f93f3251f"
          segment="owner"
        />,
      );
    // Robots.txt that disallows the whole site leaves too little to score.
    const failed = render("robots");
    expect(failed).toContain('data-robots-notice="disallowed"');
    expect(failed).toContain('data-robots-headline="disallowed"');
    expect(failed).not.toContain("data-unavailable-notice");
    // Robots.txt that disallows /.well-known/ leaves a scored teaser, in which
    // a check unavailable for another reason is still said to be unavailable.
    const teaser = render("robots-partial");
    expect(teaser).toContain('data-robots-notice="disallowed"');
    expect(teaser).toContain("data-unavailable-notice");
    const partial = render("partial");
    expect(partial).not.toContain("data-robots-notice");
    expect(partial).toContain("data-unavailable-notice");
  });

  it("headlines the scanned host and keeps the wait expectation visible", () => {
    const markup = renderToStaticMarkup(
      <ScanExperience
        browserObservationsEnabled={false}
        fixture="running"
        publicShareEnabled
        registrationEnabled
        remediationPromptEnabled
        scanId="018f3f56-2ec8-7b16-8f66-5b8f93f3251f"
        segment="owner"
      />,
    );
    expect(markup).toContain("example.com");
    expect(markup).not.toContain("Scan 018f3f56");
  });

  it("keeps privacy choices reachable from the scan help links", () => {
    const markup = renderToStaticMarkup(
      <ScanExperience
        browserObservationsEnabled={false}
        fixture="teaser"
        publicShareEnabled
        registrationEnabled
        remediationPromptEnabled
        scanId="018f3f56-2ec8-7b16-8f66-5b8f93f3251f"
        segment="owner"
      />,
    );
    expect(markup).toContain("Privacy choices");
  });
});
