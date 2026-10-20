/**
 * The SDK driven by a real merchant's catalog rather than the documentation's
 * example: a rented phone number sold synchronously at a price computed per
 * sale, and an eSIM plan whose profile arrives after the money has moved.
 *
 * Taken from the merchant's API: the two products and their modes; the
 * number's price of $8.75, reached from the supplier's $7.00 by a markup and
 * computed per sale; the eSIM delivery fields (the ICCID, the LPA string and
 * the iOS link); the supplier answering that no profile is available; and the
 * idempotency key their purchase API requires.
 *
 * Constructed, and this list is the whole of it: the eSIM plan's price of
 * $18.90, both identifiers, titles and descriptions, the eSIM's delivery
 * deadline of 900 seconds, the number's `phone_number` result field, which is
 * not taken from the merchant's API, and every timestamp on this page.
 *
 * One merchant publishes two cards, answers a price question, delivers one
 * order inside the handler and another by a later call, refuses a third,
 * receives an event, and handles the same order twice without provisioning it
 * twice, over one subscription against a gateway made of the route table.
 */

import type {
  CardInput,
  HandlerAnswer,
  Order,
  OrderEvent,
  QuoteRequest,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, expect, it } from "vitest";
import { checkCard } from "./check-card.js";
import type { OrderHandle } from "./client.js";
import { createClient } from "./client.js";
import { contractVersion } from "./contract.js";
import { type FakeGateway, type GatewayAnswer, startFakeGateway } from "./testing/fake-gateway.js";
import { waitUntil } from "./testing/waiting.js";
import type { WorkerProblem } from "./worker.js";

const API_KEY = "freeland-merchant-key";
const AT = "2026-08-26T11:00:00Z";

const numberCard: CardInput = {
  merchant_item_id: "virtual-number-monthly-nl",
  title: "Virtual phone number, the Netherlands, one month",
  description:
    "A rented number for one month, incoming SMS only. One-time codes are read out of the message automatically. Whether a given sender's code arrives depends on that sender.",
  price: { amount: "8.75", currency: "USD" },
  params: { country: { type: "string", required: true, title: "Country of the number" } },
  result: { phone_number: { type: "string", title: "The number itself" } },
  fulfillment: "sync",
  price_check: "handler",
};

const esimCard: CardInput = {
  merchant_item_id: "esim-europe-7d",
  title: "eSIM, Europe, seven days",
  description:
    "A data plan for seven days across Europe. The profile is issued after the purchase and is installed from the link or the code below; it cannot be moved to another device afterwards.",
  price: { amount: "18.90", currency: "USD" },
  result: {
    iccid: { type: "string", title: "The profile's ICCID" },
    lpa_string: { type: "string", title: "The activation string" },
    ios_tap_link: { type: "string", title: "One-tap installation on iOS" },
  },
  fulfillment: "async",
  fulfill_deadline_seconds: 900,
};

const orderFor = (id: string, item: string, amount: string, params: Order["params"]): Order => ({
  id,
  merchant_item_id: item,
  params,
  price: { amount, currency: "USD", at: AT, as_of: AT },
  test: false,
});

const numberOrder = orderFor("ord-nl-1", numberCard.merchant_item_id, "8.75", {
  country: "NL",
});
const esimOrder = orderFor("ord-esim-1", esimCard.merchant_item_id, "18.90", {});
const soldOutOrder = orderFor("ord-esim-2", esimCard.merchant_item_id, "18.90", {});

const numberQuestion: QuoteRequest = {
  merchant_item_id: numberCard.merchant_item_id,
  price_id: "price-nl-1",
  purpose: "purchase",
  expires_at: "2026-08-26T11:05:00Z",
};

const unfulfilled: OrderEvent = {
  type: "order.unfulfilled",
  order_id: soldOutOrder.id,
  at: AT,
  price: { amount: "18.90", currency: "USD" },
  reason: "refused",
};

const carrying = (...payloads: object[]): GatewayAnswer => ({
  body: { contract_version: contractVersion, envelopes: payloads },
});

const envelope = (kind: string, id: string, payload: unknown): object => ({
  kind,
  id,
  sent_at: AT,
  payload,
});

let gateway: FakeGateway | undefined;
let running: { stop(): Promise<void> } | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await gateway?.close();
  gateway = undefined;
});

it("carries one merchant's two products from publishing to the last refusal", async () => {
  // If this fails, the SDK fits the documentation's example and not a catalog
  // anybody sells.
  expect(checkCard(numberCard).problems).toStrictEqual([]);
  expect(checkCard(esimCard).problems).toStrictEqual([]);

  // The merchant's own systems, standing in for their API, whose purchase
  // endpoint takes an idempotency key.
  const supplierCostUsd = "7.00";
  const provisioned = new Map<string, { iccid: string; lpa: string; ios: string }>();
  let profilesLeft = 1;

  const provision = (idempotencyKey: string): boolean => {
    if (provisioned.has(idempotencyKey)) return true;
    if (profilesLeft === 0) return false;

    profilesLeft -= 1;
    provisioned.set(idempotencyKey, {
      iccid: "8931080000000000001",
      lpa: "LPA:1$rsp.example.net$K2-9QF-0A1",
      ios: "https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=LPA:1$rsp.example.net$K2-9QF-0A1",
    });

    return true;
  };

  const polls: GatewayAnswer[] = [
    carrying(envelope("quote_request", "env-q1", numberQuestion)),
    carrying(envelope("order", "env-o1", numberOrder)),
    carrying(envelope("order", "env-o2", esimOrder)),
    // The same eSIM order again: delivery is at least once.
    carrying(envelope("order", "env-o2", esimOrder)),
    carrying(envelope("order", "env-o3", soldOutOrder)),
    carrying(envelope("order_event", "env-e1", unfulfilled)),
  ];

  const parked = new Promise<GatewayAnswer>(() => {});
  const published: string[] = [];

  gateway = await startFakeGateway({
    apiKey: API_KEY,
    routes: {
      publish_card: (call) => {
        const key = (call.body as CardInput).merchant_item_id;
        published.push(key);
        return { body: { ok: true, id: `cat-${published.length}` } };
      },
      poll_worker: (_call, index) => polls[index] ?? parked,
      answer_quote: () => ({ body: { used: true } }),
      answer_order: () => ({ body: { ok: true, result: "delivered" } }),
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
    },
  });

  const agentify = createClient({ apiKey: API_KEY, baseUrl: gateway.url });

  const forNumber = await agentify.catalog.publish(numberCard);
  const forEsim = await agentify.catalog.publish(esimCard);

  expect(forNumber).toStrictEqual({ ok: true, id: "cat-1" });
  expect(forEsim).toStrictEqual({ ok: true, id: "cat-2" });

  const problems: WorkerProblem[] = [];
  const events: OrderEvent[] = [];
  const accepted: string[] = [];

  const takenOn = new Map<string, OrderHandle>();

  agentify.on("order", (order): HandlerAnswer => {
    if (order.merchant_item_id === numberCard.merchant_item_id) {
      return order.delivered({ phone_number: "+31 970 1020 3040" });
    }

    // The asynchronous product: taken on, provisioned behind the answer, and
    // closed later by a call on the kept order. The order's identifier is the
    // idempotency key, so the redelivery provisions nothing twice.
    accepted.push(order.id);
    takenOn.set(order.id, order);
    provision(order.id);

    return order.accepted();
  });

  agentify.on("event", (arrived) => {
    events.push(arrived);
  });

  agentify.on("problem", (problem) => problems.push(problem));

  agentify.on("quote", (question) => {
    if (question.merchant_item_id !== numberCard.merchant_item_id) {
      return question.unavailable(AT);
    }

    // The markup is the one that takes $7.00 to $8.75 in the worked example
    // the catalog was recorded from, rather than the sentence beside it that
    // calls it a fifth; the two disagree, and a pair of numbers is the firmer
    // fact.
    const cost = Number(supplierCostUsd);

    return question.available({ amount: (cost * (8.75 / 7)).toFixed(2), currency: "USD" }, AT);
  });

  running = agentify;
  await agentify.start();

  await waitUntil(() => events.length === 1, "everything through the subscription");

  // Answered against its own identifier, at the price the merchant computed,
  // not the card's.
  expect(gateway.callsTo("answer_quote")).toHaveLength(1);
  expect(gateway.callsTo("answer_quote")[0]?.params).toStrictEqual({ price_id: "price-nl-1" });
  expect(gateway.callsTo("answer_quote")[0]?.body).toStrictEqual({
    available: true,
    price: { amount: "8.75", currency: "USD" },
    as_of: AT,
  });

  // The synchronous order answered by the handler's return; the asynchronous
  // ones taken on, the redelivery as well.
  const answers = gateway.callsTo("answer_order");
  expect(answers.map((call) => call.params.order_id)).toStrictEqual([
    numberOrder.id,
    esimOrder.id,
    esimOrder.id,
    soldOutOrder.id,
  ]);
  expect(answers[0]?.body).toStrictEqual({ delivered: { phone_number: "+31 970 1020 3040" } });
  expect(answers[1]?.body).toStrictEqual({ accepted: {} });

  // The handler ran on every delivery and the merchant's system issued one
  // profile.
  expect(accepted).toStrictEqual([esimOrder.id, esimOrder.id, soldOutOrder.id]);
  expect(provisioned.size).toBe(1);
  expect(profilesLeft).toBe(0);

  // The issued profile is closed by a later call, outside the handler.
  const issued = provisioned.get(esimOrder.id);
  const delivered = await takenOn.get(esimOrder.id)?.deliver({
    iccid: issued?.iccid,
    lpa_string: issued?.lpa,
    ios_tap_link: issued?.ios,
  });

  expect(delivered).toStrictEqual({ ok: true, result: "delivered" });

  // The one the supplier had nothing for is refused, rather than left to run
  // out its deadline.
  const refused = await takenOn.get(soldOutOrder.id)?.refuse({
    code: "out_of_stock",
    message: "the supplier has no profile available for this plan",
  });

  expect(refused).toStrictEqual({ ok: true, result: "refused" });

  // The unfulfilled state that refusal recorded came back as an event, with nothing sent in
  // reply.
  expect(events).toStrictEqual([unfulfilled]);
  expect(problems).toStrictEqual([]);
});
