/**
 * An order's record as the operator reads it, built once for both readers so
 * that Postgres and memory answer alike over the same rows. Built field by
 * field rather than trimmed from the record, because the record holds the
 * buyer's key, a parcel's address, the values the buyer entered, the goods
 * and the payer's authorization, and a field added to it later must not reach
 * an operator's page unnoticed.
 */

import { onTheMerchantsOpenList, outcomeFor } from "@agentify/core";
import type { Fulfillment, Receipt, Seller } from "@nuanu-ai/agentify-contracts";
import {
  agentOrderStatusOf,
  merchantClosureOf,
  paidTransactionOf,
  paymentStatusOf,
} from "../../app/runner.js";
import { lapsedAttempt, type StoredOrder } from "../store.js";
import {
  type AgentReads,
  type OperatorOrder,
  type OperatorOrderRow,
  type OrderMerchant,
  type OrderPayment,
  type OrderStep,
  paymentUnknown,
  type SaidWord,
  segmentOf,
  type Withheld,
} from "./orders.js";

/** A merchant as an order's page names it: the row's facts and the site an agent reads. */
export interface OrderSeller extends OrderMerchant {
  readonly sellerSite: string | null;
}

export function orderRowOf(
  record: StoredOrder,
  merchant: OrderMerchant,
  title: string | null,
): OperatorOrderRow {
  const { order } = record;
  return {
    id: order.id,
    createdAt: order.timestamps.createdAt,
    pricedAt: order.price === null ? null : order.timestamps.quotedAt,
    merchant: { id: merchant.id, name: merchant.name, serviceName: merchant.serviceName },
    product: { itemId: record.itemId, merchantItemId: record.merchantItemId, title },
    price:
      order.price === null ? null : { amount: order.price.amount, currency: order.price.currency },
    status: outcomeFor(order),
    payment: paymentStatusOf(order),
    segment: segmentOf(record),
    test: order.test,
  };
}

export function operatorOrderOf(
  record: StoredOrder,
  merchant: OrderSeller,
  title: string | null,
  receipt: Receipt | null,
): OperatorOrder {
  const { order } = record;
  const words = record.paymentWords.map(saidWithoutWallets);
  return {
    ...orderRowOf(record, merchant, title),
    state: order.state,
    fulfillment: fulfillmentOf(record),
    fulfillmentMs: order.policy.deadlines.asyncFulfillmentMs,
    quoteSource: order.quoteSource,
    agent: agentReads(record, { name: merchant.serviceName, site: merchant.sellerSite }),
    merchantReads: {
      status: outcomeFor(order),
      payment_status: paymentStatusOf(order),
      ...merchantClosureOf(order),
      onOpenList: onTheMerchantsOpenList(order),
      lapsed: lapsedAttempt(record),
    },
    timeline: timelineOf(record, words),
    paid: paymentOf(record, words),
    receipt,
    withheld: withheldOf(record),
  };
}

/**
 * The agent's read, from the very function that writes it on the wire, keeping
 * only the fields an operator compares an answer against. The document is
 * built with no base address and is read field by field: its status address
 * carries the buyer's key, and its goods and shipment are the buyer's.
 */
function agentReads(record: StoredOrder, seller: Seller): AgentReads {
  const written = agentOrderStatusOf(record, seller, { publicBaseUrl: "" });
  return {
    status: written.status,
    payment_status: written.payment_status,
    seller: written.seller,
    ...(written.transaction === undefined ? {} : { transaction: written.transaction }),
    ...(written.reason === undefined ? {} : { reason: written.reason }),
    ...(written.refusal === undefined ? {} : { refusal: written.refusal }),
    ...(written.merchant_closure === undefined
      ? {}
      : { merchant_closure: written.merchant_closure }),
    ...(written.ship_by === undefined ? {} : { ship_by: written.ship_by }),
  };
}

function fulfillmentOf(record: StoredOrder): Fulfillment {
  if (record.order.mode.parcel === true) return "ship";
  return record.order.mode.settle === "after_fulfillment" ? "sync" : "async";
}

/** A wallet's address is forty hexadecimal digits; a transaction's sixty-four are left whole. */
const WALLET = /\b0x[0-9a-fA-F]{40}\b/g;

/** What the facilitator said, with every wallet address in it replaced by "a wallet". */
export const withoutWallets = (said: string): string => said.replace(WALLET, "a wallet");

const saidWithoutWallets = (word: StoredOrder["paymentWords"][number]): SaidWord => ({
  at: word.at,
  about: word.about,
  said: withoutWallets(word.said),
});

function paymentOf(record: StoredOrder, words: readonly SaidWord[]): OrderPayment {
  const { order } = record;
  const attempt = record.paymentAttempt;
  const completion = attempt?.completion ?? null;
  return {
    stage: order.payment,
    status: paymentStatusOf(order),
    paidInto: record.payTo,
    transaction: paidTransactionOf(record) ?? null,
    attempt:
      attempt === undefined
        ? null
        : {
            startedAt: attempt.startedAt,
            completion:
              completion === null
                ? null
                : {
                    settled: completion.settled,
                    executedAt: completion.settled ? completion.executedAt : null,
                    source: completion.source,
                  },
            searchHint: attempt.transaction ?? null,
            nextBlock: attempt.nextBlock ?? null,
          },
    words,
    wordsDropped: record.paymentWordsDropped,
    unknownSince: paymentUnknown(record)
      ? (order.timestamps.settleStartedAt ?? attempt?.startedAt ?? null)
      : null,
  };
}

function withheldOf(record: StoredOrder): Withheld {
  const held = record.shipTo;
  return {
    buyerEntered: Object.keys(record.params).length > 0,
    address: held === undefined ? null : "erasedAt" in held ? { erasedAt: held.erasedAt } : "held",
    goods: record.order.mode.parcel !== true && record.delivery !== null,
  };
}

/**
 * Which of two steps of one moment comes first, in the order of an order's
 * life.
 */
const PLACE: Readonly<Record<OrderStep["kind"], number>> = {
  created: 0,
  priced: 1,
  facilitator_said: 2,
  charge_sent: 3,
  paid: 4,
  payment_completed: 5,
  handed_over: 6,
  goods_delivered: 7,
  shipment_recorded: 8,
  ended: 9,
  closed_by_merchant: 10,
  paid_after_closure: 11,
  address_erased: 12,
};

/**
 * The steps a step the record keeps no time for follows: it is placed right
 * after the latest of them, never at a moment worked out from a deadline.
 */
const FOLLOWS: Readonly<Partial<Record<OrderStep["kind"], readonly OrderStep["kind"][]>>> = {
  priced: ["created"],
  payment_completed: ["created", "paid", "charge_sent"],
  goods_delivered: ["created", "paid", "handed_over"],
  ended: [
    "created",
    "priced",
    "charge_sent",
    "paid",
    "payment_completed",
    "handed_over",
    "shipment_recorded",
  ],
};

function timelineOf(record: StoredOrder, words: readonly SaidWord[]): OrderStep[] {
  const { order } = record;
  const { timestamps } = order;
  const steps: OrderStep[] = [{ kind: "created", at: timestamps.createdAt }];
  if (order.price !== null) {
    steps.push({
      kind: "priced",
      at: timestamps.quotedAt,
      price: { amount: order.price.amount, currency: order.price.currency },
    });
  }
  for (const word of words) steps.push({ kind: "facilitator_said", ...word });
  if (timestamps.settleStartedAt !== null) {
    steps.push({ kind: "charge_sent", at: timestamps.settleStartedAt });
  }
  if (timestamps.paidAt !== null) steps.push({ kind: "paid", at: timestamps.paidAt });
  const completion = record.paymentAttempt?.completion ?? null;
  if (completion !== null) {
    steps.push({
      kind: "payment_completed",
      at: completion.settled ? completion.executedAt : null,
      settled: completion.settled,
      source: completion.source,
    });
  }
  if (timestamps.dispatchedAt !== null) {
    steps.push({
      kind: "handed_over",
      at: timestamps.dispatchedAt,
      times: order.dispatch.attempts,
      takenOn: order.dispatch.accepted,
    });
  }
  if (record.delivery !== null) {
    const shippedAt =
      order.mode.parcel === true ? Date.parse(String(record.delivery.shipped_at)) : Number.NaN;
    steps.push(
      Number.isFinite(shippedAt)
        ? { kind: "shipment_recorded", at: shippedAt }
        : { kind: "goods_delivered", at: null },
    );
  }
  if (order.closure !== null) steps.push({ kind: "ended", at: null, closure: order.closure });
  const closed = order.merchantClosure;
  if (closed !== undefined) {
    steps.push({
      kind: "closed_by_merchant",
      at: closed.at,
      withMessage: closed.message !== undefined,
    });
    if (closed.paymentCompletedAt !== undefined) {
      steps.push({ kind: "paid_after_closure", at: closed.paymentCompletedAt });
    }
  }
  const held = record.shipTo;
  if (held !== undefined && "erasedAt" in held) {
    steps.push({ kind: "address_erased", at: held.erasedAt });
  }
  return inStoryOrder(steps);
}

/**
 * Timed steps by their moment; each untimed one right after the latest step it
 * follows, behind any untimed step already placed there.
 */
function inStoryOrder(steps: readonly OrderStep[]): OrderStep[] {
  const story = steps
    .filter((step) => step.at !== null)
    .sort((one, other) => (one.at ?? 0) - (other.at ?? 0) || PLACE[one.kind] - PLACE[other.kind]);
  for (const untimed of steps.filter((step) => step.at === null)) {
    const follows = FOLLOWS[untimed.kind] ?? [];
    let place = story.findLastIndex((step) => step.at !== null && follows.includes(step.kind)) + 1;
    while (place < story.length && story[place]?.at === null) place += 1;
    story.splice(place, 0, untimed);
  }
  return story;
}
