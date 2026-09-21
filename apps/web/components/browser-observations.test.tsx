import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BrowserObservationStatusResponse } from "@agentify/scanner-contracts";

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
  it("keeps browser observations outside the canonical score", () => {
    const markup = renderToStaticMarkup(
      <BrowserObservations
        host="example.com"
        initialData={observation()}
        remediationPromptEnabled
        scanId="scan-1"
        surface="report"
      />,
    );
    expect(markup).not.toContain("Build 1.0.42");
    expect(markup).not.toContain("/100");
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
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain("/100");
  });

  it("keeps off or shadow mode visually absent when no result is supplied", () => {
    const markup = renderToStaticMarkup(
      <BrowserObservations scanId="scan-1" surface="report" />,
    );
    expect(markup).toBe("");
  });

  it("does not expose evidence or fixes in the scan teaser", () => {
    const markup = renderToStaticMarkup(
      <BrowserObservations
        initialData={observation()}
        scanId="scan-1"
        surface="scan"
      />,
    );
    expect(markup).not.toContain("Unnamed Control Count");
    expect(markup).not.toContain("Copy this fix");
  });
});
