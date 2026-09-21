import React from "react";
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
    expect(markup).toContain("needs attention");
    expect(markup).toContain("What we found:");
    expect(markup).toContain(
      "No segment-specific structured-data type was found",
    );
    expect(markup).toContain("Copy share link");
    expect(markup.indexOf("Copy share link")).toBeLessThan(
      markup.indexOf("Copy AI fix prompt"),
    );
    expect(markup).toContain("The full report requires email, phone");
  });

  it("keeps the teaser actions in one panel with a single caption", () => {
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
    expect(markup).toContain("Your result is ready");
    expect(markup).toContain("unlock after a confirmed email");
  });

  it("keeps exactly one registration form and no modal dialog on the teaser", () => {
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
    expect(markup.match(/Email me a secure link/g)).toHaveLength(1);
    expect(markup).not.toContain("<dialog");
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
    expect(markup).toContain("Email verification is not enabled");
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
    expect(markup).toContain("usually under 60 s");
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

  it("labels a finished scan as complete instead of pass", () => {
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
    expect(markup).toContain(">complete</span>");
    expect(markup).toContain("Scan complete");
  });
});
