/**
 * What an order's life amounts to for product analytics: its birth, each
 * result of a payment attempt, and each change of the outcome its buyer reads.
 * Every event is read off orders as the store holds them, never off what a
 * flow meant to do, so an event says no more than the order that was written.
 */

import { type Closure, type Order, outcomeFor } from "@agentify/core";
import type {
  AnalyticsEvent,
  OrderCreated,
  OrderOutcomeChanged,
  PaymentResult,
} from "../analytics/index.js";
import type { GatewayConfig } from "../config.js";
import type { Integration, StoredOrder } from "../ports/store.js";

type MoneyMode = OrderCreated["fields"]["money_mode"];
type Network = OrderCreated["fields"]["network"];
type BuyerOutcome = OrderOutcomeChanged["fields"]["outcome"];
type PaymentState = OrderOutcomeChanged["fields"]["payment_state"];
type ReasonCode = NonNullable<OrderOutcomeChanged["fields"]["reason_code"]>;

/** Who changed an order: the gateway itself, or its merchant by the way they called. */
export type OrderActor = "system" | "merchant_worker" | "human" | "unknown";

/** Whether this deployment's money is real, and the chain it is taken on. */
export interface Channel {
  readonly moneyMode: MoneyMode;
  readonly network: Network;
}

const NETWORKS: Readonly<Record<string, Network>> = {
  "eip155:8453": "base",
  "eip155:84532": "base_sepolia",
};

/**
 * The live surface is the only one where a payment moves real money; the
 * sandbox names Base Sepolia and settles against nothing.
 */
export function channelOf(config: GatewayConfig): Channel {
  const network = NETWORKS[config.payment.network] ?? "other";
  return {
    network,
    moneyMode: config.surfaceMode === "live" && network === "base" ? "real" : "test",
  };
}

/** A new order, written for the card it was sold through `integration`. */
export function orderCreated(
  record: StoredOrder,
  integration: Integration,
  channel: Channel,
): OrderCreated {
  return {
    name: "agc_order_created",
    actor: "buyer_agent",
    source: "gateway",
    refs: { order: record.order.id, merchant: record.merchantId, item: record.itemId },
    fields: { integration, money_mode: channel.moneyMode, network: channel.network },
  };
}

/**
 * What one saved change to an order amounts to, `before` as the hold found it
 * and `after` as it was saved: a payment result where the change saved one,
 * and the buyer's outcome where it moved.
 */
export function orderChanged(
  before: StoredOrder,
  after: StoredOrder,
  channel: Channel,
  actor: OrderActor,
): AnalyticsEvent[] {
  const events: AnalyticsEvent[] = [];
  const payment = paymentResult(before, after, channel, actor);
  if (payment !== null) events.push(payment);
  const outcome = outcomeChanged(before, after, channel, actor);
  if (outcome !== null) events.push(outcome);
  return events;
}

/**
 * Paid and not paid come only from an attempt's completion as it was saved,
 * since the machine's payment stage of an old order can say settled with no
 * observed charge behind it. An unknown outcome is the stage turning unknown
 * while the attempt waits for an answer; recovery reading the chain again
 * changes neither, so it records nothing.
 */
function paymentResult(
  before: StoredOrder,
  after: StoredOrder,
  channel: Channel,
  actor: OrderActor,
): PaymentResult | null {
  const attempt = after.paymentAttempt;
  if (attempt === undefined) return null;
  const earlier = before.paymentAttempt?.id === attempt.id ? before.paymentAttempt : undefined;
  const shape = {
    name: "agc_payment_result",
    actor,
    source: "gateway",
    refs: { order: after.order.id, merchant: after.merchantId, attempt: attempt.id },
  } as const;
  const paying = { money_mode: channel.moneyMode, network: channel.network };

  const completion = attempt.completion;
  if (completion !== null) {
    if (earlier !== undefined && earlier.completion !== null) return null;
    if (!completion.settled) {
      return {
        ...shape,
        fields: { payment_state: "not_paid", ...paying, reason_code: "payment_not_settled" },
      };
    }
    const price = after.order.price;
    return {
      ...shape,
      fields:
        price === null
          ? { payment_state: "paid", ...paying }
          : { payment_state: "paid", ...paying, amount: price.amount, currency: price.currency },
    };
  }
  if (after.order.payment === "outcome_unknown" && before.order.payment !== "outcome_unknown") {
    // The stage turns unknown only when the payment layer let its deadline pass.
    return { ...shape, fields: { payment_state: "unresolved", ...paying, reason_code: "timeout" } };
  }
  return null;
}

function outcomeChanged(
  before: StoredOrder,
  after: StoredOrder,
  channel: Channel,
  actor: OrderActor,
): OrderOutcomeChanged | null {
  const outcome = buyerOutcomeOf(after.order);
  if (outcome === buyerOutcomeOf(before.order)) return null;
  const reason = outcome === "in_progress" ? null : reasonFor(after.order, outcome);
  return {
    name: "agc_order_outcome_changed",
    actor,
    source: "gateway",
    refs: { order: after.order.id, merchant: after.merchantId },
    fields: {
      outcome,
      payment_state: paymentStateOf(after),
      money_mode: channel.moneyMode,
      ...(reason === null ? {} : { reason_code: reason }),
    },
  };
}

/**
 * The buyer's outcome with an unknown payment read as still in progress, the
 * unknown being the payment result's to say, unless the order's fulfillment is
 * closed: a closure is final, so it is the outcome from the moment it is made,
 * by whoever made it, whatever the payment turns out to be.
 */
function buyerOutcomeOf(order: Order): BuyerOutcome {
  const outcome = outcomeFor(order);
  if (outcome !== "payment_unresolved") return outcome;
  return order.state === "fulfillment_closed" ? "fulfillment_closed" : "in_progress";
}

function paymentStateOf(record: StoredOrder): PaymentState {
  const completion = record.paymentAttempt?.completion ?? null;
  if (completion !== null) return completion.settled ? "paid" : "not_paid";
  switch (record.order.payment) {
    case "none":
    case "verified":
    case "settle_failed":
      return "not_paid";
    // A stage that says settled without a saved completion is an old order's,
    // whose charge nobody observed.
    case "settling":
    case "outcome_unknown":
    case "settled":
      return "unresolved";
  }
}

function reasonFor(order: Order, outcome: BuyerOutcome): ReasonCode | null {
  if (outcome === "delivered_unpaid") return "payment_not_settled";
  if (outcome === "rejected" && order.payment === "settle_failed") return "payment_not_settled";
  return order.closure === null ? null : reasonOfClosure(order.closure);
}

function reasonOfClosure(closure: Closure): ReasonCode | null {
  switch (closure.cause) {
    case "unavailable":
    case "merchant_refused":
      return "merchant_refused";
    case "quote_silent":
      return "timeout";
    case "payment_not_settled":
      return "payment_not_settled";
    case "deadline_expired":
      return "deadline_expired";
    case "payment_not_verified":
    case "payment_outcome_unknown":
    case "merchant_departed":
      return null;
  }
}
