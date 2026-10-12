/**
 * The mock merchant, built on the real SDK: everything a merchant's engineer
 * would write and nothing this slice invents. `createClient`, `catalog.publish`
 * for each card, and one `on` per kind arriving on the single subscription
 * `start` opens, as a real process would run them.
 *
 * The rented number is synchronous, so the handler returns the goods and the
 * SDK posts them; the eSIM is asynchronous, so the handler takes the order on
 * and the goods follow through the `deliver` call. It keeps the order itself
 * for that call, since the calls that close an order live on the order. Nothing
 * on this side holds the goods to the card: the gateway does, and a delivery
 * that does not match comes back refused as `delivery_does_not_match_card`,
 * reported as a problem rather than thrown here.
 *
 * It records the events and problems the SDK reports, so a test can assert what
 * did not happen too: a clean run reports no problem and, on the happy
 * asynchronous path, no event.
 */

import type {
  AgentifyClient,
  Delivery,
  LiveOrder,
  OrderCallResponse,
  OrderEvent,
  WorkerProblem,
} from "@nuanu-ai/agentify";
import { createClient } from "@nuanu-ai/agentify";
import {
  CATALOG,
  EUROPE_ESIM,
  goodsFor,
  RENTED_NUMBER,
  RENTED_NUMBER_LIVE_PRICE,
} from "./cards.js";

const asTimestamp = (at: number): string => new Date(at).toISOString();

export interface MockMerchant {
  readonly client: AgentifyClient;
  /** Order events the SDK handed to the event handler, in the order they arrived. */
  readonly events: readonly OrderEvent[];
  /** Anything the SDK reported it could not get through. Empty is the win. */
  readonly problems: readonly WorkerProblem[];
  /** Orders taken on and not yet delivered, by identifier. */
  readonly acceptedOrders: ReadonlyMap<string, LiveOrder>;
  /** Opens the subscription. */
  start(): Promise<void>;
  /** Publishes both cards; throws if the gateway will not accept one. */
  publishCatalog(): Promise<void>;
  /** Delivers the goods for an order taken on earlier: the async closure verb. */
  deliverAccepted(orderId: string): Promise<OrderCallResponse>;
  /** The goods this merchant would deliver for one order, for a test to compare. */
  goodsForOrder(orderId: string): Delivery;
  stop(): Promise<void>;
}

export function startMerchant(baseUrl: string, apiKey: string): MockMerchant {
  const client = createClient({ apiKey, baseUrl });

  const events: OrderEvent[] = [];
  const problems: WorkerProblem[] = [];
  const acceptedOrders = new Map<string, LiveOrder>();

  client.on("order", (order) => {
    const now = Date.now();
    if (order.merchant_item_id === RENTED_NUMBER.merchant_item_id) {
      // Synchronous: the handler's own return is the delivery, and the agent is
      // waiting on it right now.
      return order.delivered(goodsFor(order.merchant_item_id, order.params, now));
    }
    if (order.merchant_item_id === EUROPE_ESIM.merchant_item_id) {
      // Asynchronous: the money has already moved, so the order is taken on and
      // the profile is issued later by an explicit deliver call on this same
      // object.
      acceptedOrders.set(order.id, order);
      return order.accepted();
    }
    // A paid order for a product this merchant does not sell is a defect worth
    // surfacing, not a silent refusal.
    throw new Error(`the mock merchant has no handler for ${order.merchant_item_id}`);
  });

  client.on("quote", (question) => {
    const now = Date.now();
    if (question.merchant_item_id === RENTED_NUMBER.merchant_item_id) {
      return question.available({ ...RENTED_NUMBER_LIVE_PRICE }, asTimestamp(now));
    }
    // No other card is price-checked, so no other question should arrive; a real
    // handler still has to answer, and "not available" is the honest answer to a
    // question about a product whose price this desk does not compute.
    return question.unavailable(asTimestamp(now));
  });

  client.on("event", (event) => {
    events.push(event);
  });

  client.on("problem", (problem) => {
    problems.push(problem);
  });

  const goodsForOrder = (orderId: string): Delivery => {
    const taken = acceptedOrders.get(orderId);
    if (taken === undefined) {
      throw new Error(
        `the mock merchant did not take order ${orderId} on, so it has no goods for it`,
      );
    }
    return goodsFor(taken.merchant_item_id, taken.params, Date.now());
  };

  return {
    client,
    events,
    problems,
    acceptedOrders,
    start: () => client.start(),
    async publishCatalog() {
      for (const card of CATALOG) {
        const result = await client.catalog.publish(card);
        if (!result.ok) {
          throw new Error(
            `publishing ${card.merchant_item_id} was refused (${result.error.code}): ${JSON.stringify(result.error.problems)}`,
          );
        }
      }
    },
    deliverAccepted(orderId) {
      const taken = acceptedOrders.get(orderId);
      if (taken === undefined) {
        throw new Error(
          `the mock merchant did not take order ${orderId} on, so it has nothing to deliver`,
        );
      }
      return taken.deliver(goodsForOrder(orderId));
    },
    goodsForOrder,
    stop: () => client.stop(),
  };
}
