import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, OrderStatusSchema } from "./order-status.js";

describe("the status an order can be in", () => {
  // The promise: an agent asking what became of its purchase, and a merchant
  // restarting a worker and asking what is still open, get an answer from one
  // vocabulary. Two lists would mean two answers to one question, and the one
  // the state machine keeps would win silently.

  it("names every ending an agent can be told about", () => {
    // Compared as a set, not a sequence. The same list lives in the state
    // machine, and holding two files to one order would be a test failing over
    // something neither side means. Two of these are the distinction the fifth
    // gate exists for: `rejected` says the buyer's money did not move, and
    // `payment_unresolved` says nobody can say whether it did.
    expect([...ORDER_STATUSES].sort()).toStrictEqual(
      [
        "in_progress",
        "delivered",
        "shipped",
        "rejected",
        "payment_unresolved",
        "declined",
        "expired",
        "cancelled",
        "refund_due",
        "refunded",
        "delivered_unpaid",
      ].sort(),
    );
  });

  it("accepts each of them and nothing else", () => {
    for (const status of ORDER_STATUSES) {
      expect(OrderStatusSchema.safeParse(status).success, status).toBe(true);
    }
    for (const status of ["pending", "open", "paid", "IN_PROGRESS", ""]) {
      expect(OrderStatusSchema.safeParse(status).success, JSON.stringify(status)).toBe(false);
    }
  });

  it("refuses the machine's own words where they are finer than the buyer's", () => {
    // `failed` and `accepted` are states in the machine and not endings an
    // agent is told about: the first is folded into `rejected`, the second
    // into `in_progress`. Refusing them here is what keeps the two vocabularies
    // from being used as one — a gateway reaching for the machine's word finds
    // out at the boundary rather than shipping it to a buyer.
    for (const status of ["failed", "accepted", "dispatched", "quoted"]) {
      expect(OrderStatusSchema.safeParse(status).success, status).toBe(false);
    }
  });
});
