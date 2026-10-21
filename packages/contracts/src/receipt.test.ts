import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, OrderStatusSchema } from "./order-status.js";
import { ReceiptOutcomeSchema, ReceiptSchema } from "./receipt.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const receipt = {
  id: "rcp_4b90de",
  order_id: "ord_7c1e05",
  item_id: "itm_9f2c4a",
  price: {
    amount: "5.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  price_id: "prc_31a8c0",
  paid_at: "2026-08-26T10:20:03Z",
  outcome: "delivered",
  test: false,
};

describe("what a receipt says became of the purchase", () => {
  // The promise: a receipt says exactly what is known, in the order status's
  // own words, and "paid, delivery still running" reads as neither
  // "delivered" nor "paid and never delivered".
  it("tells apart the four states a paid purchase can be in", () => {
    for (const outcome of ["in_progress", "delivered", "unfulfilled", "fulfillment_closed"]) {
      expect(ReceiptOutcomeSchema.safeParse(outcome).success, outcome).toBe(true);
    }
  });

  it("borrows its words from the order status rather than inventing its own", () => {
    // `pending` where the order said `in_progress` would be two names for one
    // state.
    for (const outcome of ReceiptOutcomeSchema.options) {
      expect(OrderStatusSchema.safeParse(outcome).success, outcome).toBe(true);
    }
    expect(ReceiptOutcomeSchema.safeParse("pending").success).toBe(false);
  });

  it("accounts for every order status, on one side of the line or the other", () => {
    // The excluded statuses are named, so a status added to the order makes
    // this fail until someone decides which side of the receipt line it is on.
    const withoutAReceipt = [
      "rejected",
      "payment_unresolved",
      "declined",
      "expired",
      "delivered_unpaid",
    ];

    expect([...ReceiptOutcomeSchema.options, ...withoutAReceipt].sort()).toStrictEqual(
      [...ORDER_STATUSES].sort(),
    );
  });

  it("has no value for an unpaid purchase or an unknown payment", () => {
    // A refused, declined or expired purchase leaves no receipt,
    // and neither does a synchronous delivery whose payment failed. An unknown
    // outcome cannot establish that a payment executed.
    for (const outcome of [
      "rejected",
      "payment_unresolved",
      "declined",
      "expired",
      "delivered_unpaid",
      "",
    ]) {
      expect(ReceiptOutcomeSchema.safeParse(outcome).success, JSON.stringify(outcome)).toBe(false);
    }
  });
});

describe("receipt", () => {
  it("accepts the record of a completed purchase", () => {
    expect(ReceiptSchema.parse(receipt)).toStrictEqual(receipt);
  });

  it("accepts a receipt for a purchase still waiting on its delivery", () => {
    expect(ReceiptSchema.safeParse({ ...receipt, outcome: "in_progress" }).success).toBe(true);
  });

  it("accepts a historical receipt for fulfillment that was later closed", () => {
    expect(ReceiptSchema.safeParse({ ...receipt, outcome: "fulfillment_closed" }).success).toBe(
      true,
    );
  });

  it("accepts a receipt for a sale that had no price question behind it", () => {
    const { price_id, ...withoutPriceId } = receipt;
    expect(price_id).toBeDefined();
    expect(ReceiptSchema.safeParse(withoutPriceId).success).toBe(true);
  });

  // `test` is among them because an unmarked receipt for a test purchase is
  // proof of a payment that never happened.
  for (const field of ["id", "order_id", "item_id", "price", "paid_at", "outcome", "test"]) {
    it(`refuses a receipt without ${field} and names it`, () => {
      expectMissingFieldRejected(ReceiptSchema, receipt, field);
    });
  }

  it("refuses a field it does not know", () => {
    expect(errorOf(ReceiptSchema, { ...receipt, fulfillment_closed: true })).toContain(
      "fulfillment_closed",
    );
  });

  it("names the recorded payment transaction, and never an empty one", () => {
    // Without it a receipt is matched to the payment on the chain by its time
    // alone, which is a guess.
    const named = { ...receipt, transaction: `0x${"ab".repeat(32)}` };
    expect(ReceiptSchema.parse(named)).toStrictEqual(named);
    expect(errorOf(ReceiptSchema, { ...receipt, transaction: "" })).toContain("transaction");
  });
});
