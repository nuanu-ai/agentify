/**
 * What the share arithmetic refuses to say, since every screen and shop
 * order that names a share or a rate says it through this: an amount no
 * payment could have been charged at, and a rate it could only round. The
 * shares it does say are held on the orders, receipts and shop order tests.
 */

import { describe, expect, it } from "vitest";
import { percentOf, sharesOf } from "./shares.js";

const TERMS = {
  merchantAllocation: 999_000,
  commissionAllocation: 1_000,
  totalAllocation: 1_000_000,
};

describe("what the share arithmetic will not say", () => {
  it("refuses an amount written to more places than USDC carries, rather than reading it ten times over", () => {
    expect(() => sharesOf({ amount: "0.0000001", currency: "USD" }, TERMS)).toThrow(
      /not an amount USDC can be paid in/,
    );
    expect(sharesOf({ amount: "0.000001", currency: "USD" }, TERMS).merchant).toBe(
      "under 0.000001 USD",
    );
  });

  it("refuses to name a rate it could only round, so no rounded rate reads as the exact one", () => {
    expect(() => percentOf(1, 3)).toThrow(/no exact percentage/);
    expect(percentOf(1_000, 1_000_000)).toBe("0.1%");
    expect(percentOf(999_000, 1_000_000)).toBe("99.9%");
  });
});
