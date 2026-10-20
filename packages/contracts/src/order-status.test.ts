import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, OrderStatusSchema } from "./order-status.js";

describe("the status an order can be in", () => {
  // The promise: an agent asking what became of its purchase and a merchant
  // asking what is still open get their answer from one vocabulary.

  it("names every ending an agent can be told about", () => {
    // Compared as a set: the same list lives in the state machine, in its own
    // order. `rejected` says the buyer's money did not move, and
    // `payment_unresolved` that nobody can say whether it did.
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
        "unfulfilled",
        "fulfillment_closed",
        "delivered_unpaid",
      ].sort(),
    );
  });

  it("accepts each of them and nothing else", () => {
    for (const status of ORDER_STATUSES) {
      expect(OrderStatusSchema.safeParse(status).success, status).toBe(true);
    }
    for (const status of ["pending", "open", "paid", "IN_PROGRESS", "refund_due", "refunded", ""]) {
      expect(OrderStatusSchema.safeParse(status).success, JSON.stringify(status)).toBe(false);
    }
  });

  it("refuses the machine's own words where they are finer than the buyer's", () => {
    // `failed` and `accepted` are the state machine's states, folded into
    // `rejected` and `in_progress` for an agent; refusing them here keeps a
    // gateway from shipping the machine's word to a buyer.
    for (const status of ["failed", "accepted", "dispatched", "quoted"]) {
      expect(OrderStatusSchema.safeParse(status).success, status).toBe(false);
    }
  });
});
