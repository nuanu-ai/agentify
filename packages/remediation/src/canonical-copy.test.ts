import { describe, expect, it } from "vitest";

import { canonicalFindingHeadline, canonicalSummaryCopy } from "./canonical-copy.js";

describe("canonical finding copy", () => {
  it("heads a finding that has a headline of its own with it, not with the evidence statement", () => {
    expect(canonicalFindingHeadline("ssr_shell_only")).not.toBe(
      canonicalSummaryCopy("ssr_shell_only"),
    );
  });

  it("falls back to the canonical evidence statement", () => {
    expect(canonicalFindingHeadline("unknown_signal_code")).toBe(
      canonicalSummaryCopy("unknown_signal_code"),
    );
  });
});
