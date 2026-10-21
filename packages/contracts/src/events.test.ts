import { describe, expect, it } from "vitest";
import { ORDER_EVENT_TYPES, OrderEventSchema, UnfulfilledReasonSchema } from "./events.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const unfulfilled = {
  type: "order.unfulfilled",
  order_id: "ord_7c1e05",
  at: "2026-08-27T10:20:00Z",
  price: { amount: "5.00", currency: "USD" },
  reason: "deadline_passed",
};

const paymentFailed = {
  type: "order.payment_failed_after_delivery",
  order_id: "ord_7c1e05",
  at: "2026-08-26T10:20:05Z",
};

describe("the events a merchant hears without asking", () => {
  // The promise: what happens to an order without the merchant's doing
  // arrives on the same subscription as the orders.

  it("names the two", () => {
    expect(Object.values(ORDER_EVENT_TYPES)).toStrictEqual([
      "order.unfulfilled",
      "order.payment_failed_after_delivery",
    ]);
  });

  it("accepts an order marked as unfulfilled", () => {
    expect(OrderEventSchema.parse(unfulfilled)).toStrictEqual(unfulfilled);
  });

  it("accepts a payment that did not execute after a synchronous delivery", () => {
    expect(OrderEventSchema.parse(paymentFailed)).toStrictEqual(paymentFailed);
  });

  it("refuses an event of a kind we do not send", () => {
    // A consumer switching on the type must be able to read an unknown one as
    // a version mismatch, not a typo.
    for (const type of [
      "unfulfilled",
      "order.refund_due",
      "order.refunded",
      "order.fulfillment_closed",
      "order.delivered",
      "",
    ]) {
      expect(
        OrderEventSchema.safeParse({ ...paymentFailed, type }).success,
        JSON.stringify(type),
      ).toBe(false);
    }
  });

  it("refuses an event that does not say which kind it is", () => {
    expectMissingFieldRejected(OrderEventSchema, paymentFailed, "type");
  });

  for (const field of ["order_id", "at"]) {
    it(`refuses an event without ${field} and names it`, () => {
      expectMissingFieldRejected(OrderEventSchema, paymentFailed, field);
      expectMissingFieldRejected(OrderEventSchema, unfulfilled, field);
    });
  }
});

describe("an unfulfilled paid order", () => {
  // The promise: the merchant learns which order, how much and why in one
  // message, without asserting a remedy or an amount to refund.

  for (const field of ["price", "reason"]) {
    it(`refuses an unfulfilled event without ${field} and names it`, () => {
      expectMissingFieldRejected(OrderEventSchema, unfulfilled, field);
    });
  }

  it("tells the ways an order becomes unfulfilled apart", () => {
    for (const reason of ["refused", "deadline_passed", "paid_after_closure"]) {
      expect(UnfulfilledReasonSchema.safeParse(reason).success, reason).toBe(true);
      expect(OrderEventSchema.safeParse({ ...unfulfilled, reason }).success, reason).toBe(true);
    }
  });

  it("refuses a reason that is not one of them", () => {
    expect(errorOf(OrderEventSchema, { ...unfulfilled, reason: "out_of_stock" })).toContain(
      "reason",
    );
  });

  it("refuses a sum written as a number", () => {
    expect(
      OrderEventSchema.safeParse({ ...unfulfilled, price: { amount: 5, currency: "USD" } }).success,
    ).toBe(false);
  });

  it("carries the original price only on the unfulfilled paid event", () => {
    // These events establish no paid sale and therefore carry no purchase price.
    expect(
      OrderEventSchema.safeParse({ ...paymentFailed, price: { amount: "5.00", currency: "USD" } })
        .success,
    ).toBe(false);
  });
});
