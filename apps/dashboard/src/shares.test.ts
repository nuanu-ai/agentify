/**
 * What the share arithmetic refuses to say, since every screen and shop
 * order that names a share says it through this: an amount no payment could
 * have been charged at. The shares it does say are held on the orders,
 * receipts and shop order tests.
 */

import { describe, expect, it } from "vitest";
import { sharesOf } from "./shares.js";

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
});
