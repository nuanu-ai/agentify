import { createOrder, modeOf, type Order, type OrderState } from "@agentify/core";
import { describe, expect, it } from "vitest";
import { commerceSamples } from "./telemetry.js";

const now = Date.UTC(2026, 9, 20);
const reach = (state: OrderState): Order => {
  const made = createOrder({
    id: "ord_observed",
    at: 1_000,
    mode: modeOf("async"),
    priceCheck: "none",
    selling: "open",
    test: true,
    cardPrice: { amount: "5.00", currency: "USD", asOf: 1_000 },
    policy: {
      deadlines: {
        quoteResponseMs: 1_000,
        quoteTtlMs: 10_000,
        settleResponseMs: 10_000,
        syncResponseMs: 10_000,
        asyncFulfillmentMs: 10_000,
      },
      redelivery: { baseDelayMs: 1_000, factor: 2, maxDelayMs: 10_000, maxAttempts: 2 },
    },
  });
  if (!made.ok) throw new Error("test order refused");
  return { ...made.order, state };
};
const sample = (orders: Order[]) =>
  commerceSamples(
    orders.map((order) => ({ record: { order } })),
    now,
  );
const value = (samples: ReturnType<typeof sample>, name: string) =>
  samples.find((s) => s.name === name)?.value;

describe("commerce operational observations", () => {
  it("keeps an unknown payment visible even when the order is closed", () => {
    const rejected = reach("rejected");
    const samples = sample([
      {
        ...rejected,
        payment: "outcome_unknown",
        timestamps: {
          ...rejected.timestamps,
          createdAt: now - 3_600_000,
          settleStartedAt: now - 60_000,
        },
      },
    ]);
    expect(value(samples, "agentify_commerce_open_orders")).toBe(0);
    expect(value(samples, "agentify_commerce_payment_unknown_orders")).toBe(1);
    expect(value(samples, "agentify_commerce_oldest_unknown_settlement_age_seconds")).toBe(60);
  });

  it("uses the order's own deadlines and never calls an unfulfilled order overdue", () => {
    const paid = reach("paid");
    const late: Order = {
      ...paid,
      timestamps: { ...paid.timestamps, paidAt: now - 20_000 },
      policy: {
        ...paid.policy,
        deadlines: { ...paid.policy.deadlines, syncResponseMs: 10_000, asyncFulfillmentMs: 10_000 },
      },
    };
    const samples = sample([late, reach("unfulfilled"), reach("delivered_unpaid")]);
    expect(value(samples, "agentify_commerce_overdue_orders")).toBe(1);
    expect(value(samples, "agentify_commerce_oldest_overdue_age_seconds")).toBe(10);
  });

  it("counts unique retained orders in the recent creation cohort, not attempts", () => {
    const order = reach("delivered");
    const samples = sample([
      { ...order, id: "ord_recent", timestamps: { ...order.timestamps, createdAt: now - 60_000 } },
      order,
    ]);
    expect(
      samples.find(
        (s) => s.name === "agentify_commerce_recent_orders" && s.labels?.state === "delivered",
      )?.value,
    ).toBe(1);
    expect(JSON.stringify(samples)).not.toContain(order.id);
  });

  it("reports a complete empty observation as zero and refuses truncated or invalid observations", () => {
    expect(value(sample([]), "agentify_commerce_payment_unknown_orders")).toBe(0);
    expect(() => sample(Array.from({ length: 1_001 }, () => reach("created")))).toThrow(
      "row_limit",
    );
    const order = reach("rejected");
    expect(() =>
      sample([
        {
          ...order,
          payment: "outcome_unknown",
          timestamps: { ...order.timestamps, settleStartedAt: null },
        },
      ]),
    ).toThrow("invalid_data");
  });
});
