import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReportBenchmark } from "./report-benchmark";

describe("the benchmark on a report", () => {
  it("names the segment average and the sample it rests on", () => {
    const markup = renderToStaticMarkup(
      <ReportBenchmark benchmark={{ sample_size: 42, average_score: 55.4 }} />,
    );

    expect(markup).toContain("Segment average 55 from 42 scans");
  });

  it("says nothing before the sample gate is met, rather than a number that is not there", () => {
    expect(renderToStaticMarkup(<ReportBenchmark benchmark={null} />)).toBe("");
  });
});
