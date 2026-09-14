import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrowserObservationStatusResponse } from "@b2a/contracts";

import { BrowserObservations } from "./browser-observations";

function observation(
  overrides: Partial<BrowserObservationStatusResponse> = {},
): BrowserObservationStatusResponse {
  return {
    version: "browser-public-v1.0.0",
    status: "partial",
    non_scoring: true,
    pages_assessed: 2,
    findings: [
      {
        id: "accessibility_structure",
        status: "partial",
        summary_code: "unnamed_controls_found",
        user_impact_code: "agents_cannot_identify_controls",
        remediation_code: "name_interactive_controls",
        evidence: { unnamed_control_count: 3 },
      },
      {
        id: "browser_console_health",
        status: "unavailable",
        summary_code: "provider_timeout",
        evidence: {},
      },
    ],
    updated_at: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

describe("BrowserObservations", () => {
  it("renders the report as separate non-scoring enrichment", () => {
    const markup = renderToStaticMarkup(
      <BrowserObservations
        host="example.com"
        initialData={observation()}
        remediationPromptEnabled
        scanId="scan-1"
        surface="report"
      />,
    );
    expect(markup).toContain("Non-scoring enrichment");
    expect(markup).not.toContain("Build 1.0.42");
    expect(markup).toContain("Accessibility structure");
    expect(markup).toContain("unavailable");
    expect(markup).toContain("Copy this fix");
    expect(markup).not.toContain("/100");
  });

  it("uses neutral language for blocked browser work", () => {
    const markup = renderToStaticMarkup(
      <BrowserObservations
        initialData={observation({ status: "blocked", findings: [] })}
        scanId="scan-1"
        surface="report"
      />,
    );
    expect(markup).toContain("No bypass was attempted");
    expect(markup).toContain("not a site failure");
  });

  it("announces queued work without changing the canonical score", () => {
    const markup = renderToStaticMarkup(
      <BrowserObservations
        initialData={observation({
          status: "queued",
          pages_assessed: 0,
          findings: [],
        })}
        scanId="scan-1"
        surface="scan"
      />,
    );
    expect(markup).toContain("Browser analysis queued");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("does not delay or recalculate");
  });

  it("keeps off or shadow mode visually absent when no result is supplied", () => {
    const markup = renderToStaticMarkup(
      <BrowserObservations scanId="scan-1" surface="report" />,
    );
    expect(markup).toBe("");
  });

  it("presents provider unavailability as non-scoring context", () => {
    const markup = renderToStaticMarkup(
      <BrowserObservations
        initialData={observation({ status: "unavailable", findings: [] })}
        scanId="scan-1"
        surface="report"
      />,
    );
    expect(markup).toContain("provider or safety budget");
    expect(markup).toContain("base report remains valid and unchanged");
    expect(markup).not.toContain("/100");
  });

  it("does not expose evidence or fixes in the scan teaser", () => {
    const markup = renderToStaticMarkup(
      <BrowserObservations
        initialData={observation()}
        scanId="scan-1"
        surface="scan"
      />,
    );
    expect(markup).toContain("Accessibility structure");
    expect(markup).not.toContain("Unnamed Control Count");
    expect(markup).not.toContain("Copy this fix");
  });
});
