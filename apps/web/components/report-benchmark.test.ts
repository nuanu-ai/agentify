import { describe, expect, it } from "vitest";

import { benchmarkCaption } from "./report-benchmark";

describe("the benchmark on a report", () => {
  it("says nothing before the sample gate is met, rather than a number that is not there", () => {
    expect(benchmarkCaption(null)).toBeNull();
  });
});
