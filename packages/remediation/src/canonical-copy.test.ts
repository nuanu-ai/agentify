import { describe, expect, it } from "vitest";

import { canonicalFindingHeadline, canonicalSummaryCopy } from "./canonical-copy";

describe("canonical finding copy", () => {
  it("uses concise evidence-safe teaser headlines", () => {
    expect(canonicalFindingHeadline("ssr_shell_only")).toBe(
      "Your core content is unavailable until JavaScript runs",
    );
    expect(canonicalFindingHeadline("vertical_jsonld_incomplete")).toBe(
      "Business-specific structured data is missing key public facts",
    );
    expect(canonicalFindingHeadline("content_signal_absent")).toBe(
      "No Content-Signal policy is declared",
    );
    expect(canonicalFindingHeadline("content_signal_partial")).toBe(
      "The Content-Signal declaration is incomplete or inconsistent",
    );
    expect(canonicalFindingHeadline("jsonld_absent_or_invalid")).toBe(
      "No readable JSON-LD structured data was found",
    );
    expect(canonicalFindingHeadline("markdown_negotiation_absent")).toBe(
      "No alternate machine-readable Markdown view was found",
    );
    expect(canonicalFindingHeadline("mcp_absent")).toBe(
      "No MCP declaration was found at the assessed locations",
    );
    expect(canonicalFindingHeadline("sitemap_missing")).toBe(
      "No sitemap was found in robots.txt or the standard location",
    );
    expect(canonicalFindingHeadline("vertical_jsonld_missing")).toBe(
      "No segment-specific structured-data type was found",
    );
    expect(canonicalFindingHeadline("robots_partially_parseable")).toBe(
      "Part of your crawler policy is malformed or ambiguous",
    );
    expect(canonicalFindingHeadline("llms_malformed")).toBe(
      "Your llms.txt file cannot guide automated readers reliably",
    );
  });

  it("falls back to the canonical evidence statement", () => {
    expect(canonicalFindingHeadline("unknown_signal_code")).toBe(
      canonicalSummaryCopy("unknown_signal_code"),
    );
  });
});
