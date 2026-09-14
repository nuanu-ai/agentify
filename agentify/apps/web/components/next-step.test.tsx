import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NextStep } from "./next-step";

describe("NextStep", () => {
  it("keeps the intent question compact with chips and a collapsed custom answer", () => {
    const markup = renderToStaticMarkup(
      <NextStep
        benchmark={null}
        entryId="018f3f56-2ec8-7b16-8f66-5b8f93f3251f"
        initialAnswer={null}
        scanId="018f3f56-2ec8-7b16-8f66-5b8f93f3251f"
        waitlistPosition="40"
      />,
    );
    expect(markup).toContain("What do you want to do next?");
    expect(markup).toContain("Fix it with AI");
    expect(markup).toContain("Send to a developer");
    expect(markup).toContain("Share with my team");
    expect(markup).toContain("Waitlist #40");
    expect(markup).toContain("<details");
    expect(markup).toContain("Benchmark forms after 30 eligible scans");
  });

  it("names the segment average when the benchmark exists", () => {
    const markup = renderToStaticMarkup(
      <NextStep
        benchmark={{ sample_size: 42, average_score: 55.4 }}
        entryId="018f3f56-2ec8-7b16-8f66-5b8f93f3251f"
        initialAnswer={null}
        scanId="018f3f56-2ec8-7b16-8f66-5b8f93f3251f"
        waitlistPosition="40"
      />,
    );
    expect(markup).toContain("Segment average 55 from 42 scans");
  });
});
