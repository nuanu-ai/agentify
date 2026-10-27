import { describe, expect, it } from "vitest";

import { canonicalFindingHeadline } from "./canonical-copy.js";

describe("canonical finding copy", () => {
  it("heads a finding that has a headline of its own with it, not with the evidence statement", () => {
    expect(canonicalFindingHeadline("ssr_shell_only")).toMatch(
      /core content.*unavailable.*JavaScript/i,
    );
  });

  it("falls back to the canonical evidence statement", () => {
    expect(canonicalFindingHeadline("unknown_signal_code")).toBe("Unknown signal code.");
  });
});
