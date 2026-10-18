import { describe, expect, it } from "vitest";

import { benchmarkCaption } from "./report-benchmark";

describe("the benchmark on a report", () => {
  it("exposes the average and its sample together", () => {
    const caption = benchmarkCaption({ sample_size: 42, average_score: 55.4 });

    expect(caption).toContain("55");
    expect(caption).toContain("42");
  });

  it("says nothing before the sample gate is met, rather than a number that is not there", () => {
    expect(benchmarkCaption(null)).toBeNull();
  });
});
