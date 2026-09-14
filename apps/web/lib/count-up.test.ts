import { describe, expect, it } from "vitest";

import { countUpValue } from "./count-up";

describe("countUpValue", () => {
  it("starts at zero", () => {
    expect(countUpValue(0, 46)).toBe(0);
  });

  it("reaches the target at the end", () => {
    expect(countUpValue(1, 46)).toBe(46);
  });

  it("eases out (front-loaded), so half-time is past halfway", () => {
    const mid = countUpValue(0.5, 100);
    expect(mid).toBeGreaterThan(50);
    expect(mid).toBeLessThan(100);
  });

  it("is non-decreasing across progress", () => {
    let previous = -1;
    for (let p = 0; p <= 1.0001; p += 0.1) {
      const v = countUpValue(p, 88);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });

  it("clamps progress outside 0..1", () => {
    expect(countUpValue(-0.5, 46)).toBe(0);
    expect(countUpValue(2, 46)).toBe(46);
  });

  it("stays at zero for a zero target", () => {
    expect(countUpValue(0.5, 0)).toBe(0);
  });
});
