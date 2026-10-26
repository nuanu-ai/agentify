import { describe, expect, it } from "vitest";
import { type ZodType, z } from "zod";
import {
  AgentOrderStatusSchema,
  API_ROUTES,
  AUTH_MODES,
  CatalogPageSchema,
  cardsOf,
  ERROR_CODES,
  ErrorEnvelopeSchema,
  expandPath,
  HTTP_METHODS,
  MERCHANT_KEY_HEADER,
  MerchantCardListSchema,
  merchantKeyFrom,
  merchantKeyHeaderValue,
  mountableRoutes,
  OrderAcceptResponseSchema,
  OrderCallResponseSchema,
  OrderListQuerySchema,
  OrderListSchema,
  OrderWithStatusSchema,
  PurchaseRequestSchema,
  pathParamsOf,
  QuoteAnswerAckSchema,
  ReceiptListSchema,
  type RouteDefinition,
  type RouteName,
  WorkerPollRequestSchema,
  WorkerPollResponseSchema,
} from "./api.js";
import { CardSchema, publicCardOf } from "./card.js";
import { CONTRACT_VERSION, type SchemaName, schemas, toJsonSchemas } from "./index.js";
import { readerOf } from "./reading.js";
import { ORDER_CALL_ERROR_CODES, ORDER_CALL_RESULTS } from "./results.js";
import { errorOf, expectMissingFieldRejected } from "./testing/expect-schema.js";

const order = {
  id: "ord_7c1e05",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: {
    amount: "5.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  price_id: "prc_31a8c0",
  test: false,
};

const openOrder = { ...order, status: "in_progress", payment_status: "paid" };

const publicCard = publicCardOf(
  CardSchema.parse({
    merchant_item_id: "access-monthly",
    title: "Доступ к сервису на один месяц",
    description: "Доступ на 30 дней с момента выдачи, продление не входит.",
    price: { amount: "5.00", currency: "USD" },
    params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
    result: { access_url: { type: "string", title: "Ссылка для входа" } },
    fulfillment: "sync",
  }),
  {
    id: "itm_4d21bb",
    purchase_url: "https://agentify.ad/x402/itm_4d21bb/purchase",
    as_of: "2026-08-26T09:00:00Z",
    seller: { name: "Freeland", site: null },
  },
);

const orderEnvelope = {
  kind: "order",
  id: "msg_4a19be",
  sent_at: "2026-08-26T10:20:01Z",
  payload: order,
};

/**
 * Whether a schema accepts a value and, when it does not, why, so a failure
 * names the field instead of "expected false to be true".
 */
const verdictOf = (schema: ZodType, value: unknown): string => {
  const result = schema.safeParse(value);
  return result.success ? "accepted" : `refused: ${z.prettifyError(result.error)}`;
};

const callError = {
  code: "order_already_closed",
  message: "Заказ уже закрыт, выдавать по нему нечего",
  retryable: false,
};

describe("an order read back with its state", () => {
  // The promise: a restarted worker learns what it still owes from one
  // document carrying the order and the word for where it stands.

  it("accepts an order with the state it is in", () => {
    expect(OrderWithStatusSchema.parse(openOrder)).toStrictEqual(openOrder);
  });

  // Only `status`: the other fields come from `OrderSchema` through `extend`
  // and are asked about in `order.test.ts`. If the extension is ever written
  // out by hand, those cases have to come back here.
  it("refuses an order read back without status and names it", () => {
    expectMissingFieldRejected(OrderWithStatusSchema, openOrder, "status");
  });

  it("refuses a word that is not one of the endings the agent and merchant share", () => {
    // A state under a word nobody publishes would be a second answer to "what
    // became of it".
    expect(errorOf(OrderWithStatusSchema, { ...order, status: "dispatched" })).toContain("status");
    expect(OrderWithStatusSchema.safeParse({ ...openOrder, status: "delivered" }).success).toBe(
      true,
    );
    expect(OrderWithStatusSchema.safeParse({ ...openOrder, status: "unfulfilled" }).success).toBe(
      true,
    );
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(OrderWithStatusSchema, { ...openOrder, attempts: 2 })).toContain("attempts");
  });

  it("names the transaction that paid the order to the merchant's reader, is read without one, and never names an empty one", () => {
    const paid = { ...openOrder, transaction: `0x${"ab".repeat(32)}` };

    expect(OrderWithStatusSchema.parse(paid)).toStrictEqual(paid);
    expect(readerOf(OrderWithStatusSchema).parse(paid).transaction).toBe(paid.transaction);
    expect(OrderWithStatusSchema.parse(openOrder)).not.toHaveProperty("transaction");
    expect(errorOf(OrderWithStatusSchema, { ...openOrder, transaction: "" })).toContain(
      "transaction",
    );
    expect(errorOf(OrderWithStatusSchema, { ...openOrder, transaction: " " })).toContain(
      "transaction",
    );
  });
});

describe("the list of orders", () => {
  it("accepts a merchant with nothing open", () => {
    // "You owe nothing" must not look like a broken call.
    expect(OrderListSchema.parse({ orders: [] })).toStrictEqual({ orders: [] });
  });

  it("accepts a list of orders read back with their states", () => {
    expect(
      OrderListSchema.safeParse({ orders: [openOrder, { ...openOrder, status: "unfulfilled" }] })
        .success,
    ).toBe(true);
  });

  it("is an object rather than a bare array", () => {
    // A bare array cannot grow a cursor or a count without breaking readers.
    expect(OrderListSchema.safeParse([openOrder]).success).toBe(false);
    expect(errorOf(OrderListSchema, {})).toContain("orders");
  });

  it("holds every order in the list to the same document", () => {
    expect(OrderListSchema.safeParse({ orders: [order] }).success).toBe(false);
  });
});

describe("the merchant's own cards", () => {
  // The promise: a merchant sees what they published, whether each card is
  // selling, and whether the whole catalog is stopped, none of which the
  // public catalog answers.
  const merchantCard = {
    id: "itm_4d21bb",
    as_of: "2026-08-26T09:00:00Z",
    card: {
      merchant_item_id: "access-monthly",
      title: "Доступ к сервису на один месяц",
      description: "Доступ на 30 дней с момента выдачи, продление не входит.",
      price: { amount: "5.00", currency: "USD" },
      result: { access_url: { type: "string" } },
      fulfillment: "sync",
    },
    selling: "open",
    paused: false,
  };
  const cards = { selling: "open", cards: [merchantCard] };

  it("accepts a merchant who has published nothing yet", () => {
    // "You have published nothing" must not look like a broken call.
    expect(MerchantCardListSchema.parse({ selling: "open", cards: [] })).toStrictEqual({
      selling: "open",
      cards: [],
    });
  });

  it("says whether the merchant is selling at all, beside the cards", () => {
    // A stopped catalog makes every card read paused, and this field says why.
    const stopped = MerchantCardListSchema.parse({
      selling: "paused",
      cards: [{ ...merchantCard, selling: "paused" }],
    });

    expect(stopped.selling).toBe("paused");
  });

  for (const field of ["selling", "cards"]) {
    it(`refuses the merchant's catalog without ${field} and names it`, () => {
      expectMissingFieldRejected(MerchantCardListSchema, cards, field);
    });
  }

  it("is an object rather than a bare array", () => {
    // A bare array has nowhere for the selling word and cannot grow.
    expect(MerchantCardListSchema.safeParse([merchantCard]).success).toBe(false);
  });

  it("holds every card in the list to the document a merchant reads", () => {
    expect(
      MerchantCardListSchema.safeParse({ selling: "open", cards: [merchantCard.card] }).success,
    ).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(MerchantCardListSchema, { ...cards, revenue: "1000.00" })).toContain("revenue");
  });
});

describe("the merchant's own receipts", () => {
  // The promise: a merchant reads back the payments that went through, the
  // list they reconcile their wallet against.
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
    paid_at: "2026-08-26T10:20:03Z",
    outcome: "delivered",
    test: false,
  };

  it("accepts a merchant who has sold nothing yet", () => {
    expect(ReceiptListSchema.parse({ receipts: [] })).toStrictEqual({ receipts: [] });
  });

  it("accepts the receipts of purchases that were paid for", () => {
    expect(
      ReceiptListSchema.safeParse({
        receipts: [receipt, { ...receipt, id: "rcp_c30f45", outcome: "unfulfilled" }],
      }).success,
    ).toBe(true);
  });

  it("is an object rather than a bare array", () => {
    expect(ReceiptListSchema.safeParse([receipt]).success).toBe(false);
    expect(errorOf(ReceiptListSchema, {})).toContain("receipts");
  });

  it("holds every receipt in the list to the receipt document", () => {
    // A row without the moment the price was true cannot be reconciled.
    const withoutAsOf = {
      ...receipt,
      price: { amount: "5.00", currency: "USD", at: receipt.paid_at },
    };

    expect(ReceiptListSchema.safeParse({ receipts: [withoutAsOf] }).success).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(ReceiptListSchema, { receipts: [], total: "5.00" })).toContain("total");
  });
});

describe("asking for only the open orders", () => {
  it("accepts the question with and without the filter", () => {
    expect(OrderListQuerySchema.parse({})).toStrictEqual({});
    expect(OrderListQuerySchema.parse({ open: "true" })).toStrictEqual({ open: "true" });
    expect(OrderListQuerySchema.safeParse({ open: "false" }).success).toBe(true);
  });

  it("takes the two words a query string can carry and nothing else", () => {
    // A query string carries text, and a boolean here would export as one.
    // `?open=1` is refused rather than silently answered with every order.
    expect(OrderListQuerySchema.safeParse({ open: true }).success).toBe(false);
    expect(OrderListQuerySchema.safeParse({ open: "1" }).success).toBe(false);
    expect(OrderListQuerySchema.safeParse({ open: "yes" }).success).toBe(false);
    expect(OrderListQuerySchema.safeParse({ open: "" }).success).toBe(false);
  });

  it("refuses a filter it does not have", () => {
    expect(errorOf(OrderListQuerySchema, { since: "2026-08-26T00:00:00Z" })).toContain("since");
  });
});

describe("the poll a worker makes", () => {
  it("accepts a poll that names nothing and takes our defaults", () => {
    expect(WorkerPollRequestSchema.parse({})).toStrictEqual({});
  });

  it("accepts a wait window and a batch size", () => {
    const asked = { wait_seconds: 25, max: 10 };
    expect(WorkerPollRequestSchema.parse(asked)).toStrictEqual(asked);
  });

  it("accepts a poll that asks for no wait at all", () => {
    // A drain: whatever is queued now, at once. The SDK's worker does not
    // send one, but the contract allows it.
    expect(WorkerPollRequestSchema.safeParse({ wait_seconds: 0 }).success).toBe(true);
  });

  it("refuses a wait that is not a wait", () => {
    expect(WorkerPollRequestSchema.safeParse({ wait_seconds: -1 }).success).toBe(false);
    expect(WorkerPollRequestSchema.safeParse({ wait_seconds: 2.5 }).success).toBe(false);
  });

  it("refuses a batch of no envelopes", () => {
    // At most zero would look exactly like a quiet queue for ever.
    expect(WorkerPollRequestSchema.safeParse({ max: 0 }).success).toBe(false);
    expect(WorkerPollRequestSchema.safeParse({ max: 1 }).success).toBe(true);
  });

  it("puts no ceiling on either, because a ceiling would be the gateway's", () => {
    // Any limit is the gateway's own: whatever is asked, it answers with its
    // own window and batch size.
    expect(WorkerPollRequestSchema.safeParse({ wait_seconds: 86_400 }).success).toBe(true);
    expect(WorkerPollRequestSchema.safeParse({ max: 1_000_000 }).success).toBe(true);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(WorkerPollRequestSchema, { cursor: "abc" })).toContain("cursor");
  });
});

describe("what a poll answers with", () => {
  it("accepts an empty batch, which is the answer to a quiet window", () => {
    // The ordinary case, not a failure; a worker reading it as one would
    // restart its subscription every idle window.
    const quiet = { contract_version: CONTRACT_VERSION, envelopes: [] };

    expect(WorkerPollResponseSchema.parse(quiet)).toStrictEqual(quiet);
  });

  it("names the contract version the gateway speaks, on every answer", () => {
    // A worker started against a gateway of another version must fail at
    // startup, not on somebody's first order.
    expectMissingFieldRejected(
      WorkerPollResponseSchema,
      { contract_version: CONTRACT_VERSION, envelopes: [] },
      "contract_version",
    );
    expect(
      WorkerPollResponseSchema.safeParse({ contract_version: "", envelopes: [] }).success,
    ).toBe(false);
  });

  it("accepts a batch of envelopes of different kinds on one stream", () => {
    const batch = {
      contract_version: CONTRACT_VERSION,
      envelopes: [
        orderEnvelope,
        {
          kind: "order_event",
          id: "msg_1f77a0",
          sent_at: "2026-08-27T10:20:00Z",
          payload: {
            type: "order.unfulfilled",
            order_id: "ord_7c1e05",
            at: "2026-08-27T10:20:00Z",
            price: { amount: "5.00", currency: "USD" },
            reason: "deadline_passed",
          },
        },
      ],
    };

    expect(WorkerPollResponseSchema.safeParse(batch).success).toBe(true);
  });

  it("refuses a batch with an envelope nobody can read", () => {
    expect(
      WorkerPollResponseSchema.safeParse({
        contract_version: CONTRACT_VERSION,
        envelopes: [{ ...orderEnvelope, kind: "invoice" }],
      }).success,
    ).toBe(false);
  });

  it("is an object rather than a bare array", () => {
    expect(WorkerPollResponseSchema.safeParse([orderEnvelope]).success).toBe(false);
    expect(errorOf(WorkerPollResponseSchema, {})).toContain("envelopes");
  });
});

describe("what answering for an order comes back as", () => {
  // The promise: success and failure are told apart by one test, and the
  // word inside a success is to record, not to branch on. A repeated delivery
  // succeeds as `already_delivered`, so `if (result === 'delivered')` would
  // turn a safe retry into a failure branch.

  for (const result of ORDER_CALL_RESULTS) {
    it(`carries "${result}" under the same marker of success as every other`, () => {
      const answer = OrderCallResponseSchema.parse({ ok: true, result });

      expect(answer.ok).toBe(true);
      expect(answer).toStrictEqual({ ok: true, result });
    });
  }

  it("marks success with something every language reads the same way", () => {
    // A value, not a key that may hold an empty object, which reads as false
    // in some languages.
    const delivered = OrderCallResponseSchema.parse({ ok: true, result: "delivered" });
    const accepted = OrderAcceptResponseSchema.parse({ ok: true });
    const failed = OrderCallResponseSchema.parse({ ok: false, error: callError });

    expect([delivered.ok, accepted.ok, failed.ok]).toStrictEqual([true, true, false]);
  });

  it("carries a failure that says whether calling again could change anything", () => {
    expect(OrderCallResponseSchema.parse({ ok: false, error: callError })).toStrictEqual({
      ok: false,
      error: callError,
    });
  });

  it("refuses an answer that is both, or neither", () => {
    // Two answers at once.
    expect(
      OrderCallResponseSchema.safeParse({ ok: true, result: "delivered", error: callError })
        .success,
    ).toBe(false);
    expect(OrderCallResponseSchema.safeParse({ ok: false, result: "delivered" }).success).toBe(
      false,
    );
    expect(OrderCallResponseSchema.safeParse({}).success).toBe(false);
  });

  it("refuses a failure with nothing said about why", () => {
    // "No" without a reason gives a merchant nothing to branch on, print or
    // record about an order somebody paid for.
    expect(OrderCallResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });

  it("refuses a success with no word for which success it was", () => {
    // Delivering and refusing have words, and the merchant records which.
    expect(OrderCallResponseSchema.safeParse({ ok: true }).success).toBe(false);
  });

  it("refuses a success word the vocabulary does not carry", () => {
    // A word never promised is one the next release can rename.
    expect(OrderCallResponseSchema.safeParse({ ok: true, result: "ok" }).success).toBe(false);
    expect(OrderCallResponseSchema.safeParse({ ok: true, result: "taken_on" }).success).toBe(false);
    expect(OrderCallResponseSchema.safeParse({ ok: true, result: "" }).success).toBe(false);
  });

  it("refuses a failure with no flag about retrying", () => {
    const { retryable, ...withoutFlag } = callError;
    expect(retryable).toBeDefined();
    expect(OrderCallResponseSchema.safeParse({ ok: false, error: withoutFlag }).success).toBe(
      false,
    );
  });
});

describe("what taking an order on comes back as", () => {
  it("succeeds without a word for what happened", () => {
    // Every success of this route is the same bare `ok: true`, already
    // delivered included, so a redelivered order taken on again has nothing
    // to get wrong.
    expect(OrderAcceptResponseSchema.parse({ ok: true })).toStrictEqual({ ok: true });
  });

  it("refuses a word smuggled into the success", () => {
    expect(OrderAcceptResponseSchema.safeParse({ ok: true, result: "delivered" }).success).toBe(
      false,
    );
    expect(OrderAcceptResponseSchema.safeParse({ ok: true, result: "accepted" }).success).toBe(
      false,
    );
  });

  it("fails the same way the other order calls do", () => {
    expect(OrderAcceptResponseSchema.parse({ ok: false, error: callError })).toStrictEqual({
      ok: false,
      error: callError,
    });
    expect(OrderAcceptResponseSchema.safeParse({}).success).toBe(false);
    expect(OrderAcceptResponseSchema.safeParse({ ok: true, error: callError }).success).toBe(false);
  });
});

describe("what answering a price question comes back as", () => {
  it("says whether the answer was in time to price the purchase", () => {
    expect(QuoteAnswerAckSchema.parse({ used: true })).toStrictEqual({ used: true });
    expect(QuoteAnswerAckSchema.parse({ used: false })).toStrictEqual({ used: false });
  });

  it("refuses an acknowledgement that does not say", () => {
    // Read as used, a silent flag leaves stock held; read as unused, it
    // releases stock under a sale that is going through.
    expectMissingFieldRejected(QuoteAnswerAckSchema, { used: true }, "used");
    expect(QuoteAnswerAckSchema.safeParse({ used: "true" }).success).toBe(false);
  });

  it("refuses a field it does not know", () => {
    expect(errorOf(QuoteAnswerAckSchema, { used: true, reason: "expired" })).toContain("reason");
  });
});

describe("the purchase an agent sends", () => {
  it("always carries the parameters, empty for a product that needs none", () => {
    // As in the order: "no parameters" and "did not arrive" never look alike.
    expect(PurchaseRequestSchema.parse({ params: {} })).toStrictEqual({ params: {} });
    expect(
      PurchaseRequestSchema.safeParse({ params: { email: "buyer@example.com" } }).success,
    ).toBe(true);
    expectMissingFieldRejected(PurchaseRequestSchema, { params: {} }, "params");
  });

  it("refuses a parameter name no card could have declared", () => {
    expect(PurchaseRequestSchema.safeParse({ params: { "not ok": 1 } }).success).toBe(false);
  });

  it("refuses a field it does not know", () => {
    // Whether the parameters fit a card is checked against that card at
    // purchase; this document carries the envelope.
    expect(errorOf(PurchaseRequestSchema, { params: {}, price: "5.00" })).toContain("price");
  });
});

describe("the status an agent reads", () => {
  const price = {
    amount: "80.00",
    currency: "USD",
    at: "2026-08-26T12:00:00.000Z",
    as_of: "2026-08-26T11:59:00.000Z",
  };
  const status = {
    order_id: "ord_7c1e05",
    status: "in_progress",
    payment_status: "paid",
    price,
    delivered: null,
    test: true,
    status_url: "https://agentify.ad/x402/orders/bk_3f9a1c07d2b84e6a9c5d0e1f2a3b4c5d/status",
    seller: { name: "Freeland", site: "https://freeland.example" },
  };

  it("names the order it is about", () => {
    // An agent with several purchases running files a status by its order.
    expect(AgentOrderStatusSchema.parse(status)).toStrictEqual(status);
  });

  it("carries the goods once they are released", () => {
    // An agent that bought goods that come later comes back for them here.
    const collected = { ...status, status: "delivered", delivered: { access_code: "SESAME" } };

    expect(AgentOrderStatusSchema.parse(collected)).toStrictEqual(collected);
  });

  it("says an order was never priced rather than leaving the field out", () => {
    // A purchase can close before a price was named; null says so, where an
    // absent field would look like an oversight.
    expect(AgentOrderStatusSchema.parse({ ...status, price: null }).price).toBeNull();
  });

  it("says why an order ended where Agentify and not its merchant decided it", () => {
    // A word to branch on and a sentence saying what to do; an unknown word
    // falls through to the sentence.
    const priceGone = {
      ...status,
      status: "expired",
      reason: { code: "price_expired", message: "The price ran out; start a new purchase." },
    };
    const unknownWord = { ...priceGone, reason: { code: "a_later_word", message: "Ask again." } };

    expect(AgentOrderStatusSchema.parse(priceGone)).toStrictEqual(priceGone);
    expect(AgentOrderStatusSchema.parse(unknownWord).reason?.code).toBe("a_later_word");
    expect(
      AgentOrderStatusSchema.safeParse({
        ...priceGone,
        reason: { code: "price_expired", message: " " },
      }).success,
    ).toBe(false);
  });

  it("lists, for a generated client to switch on, why fulfillment failed beside why an order ended", () => {
    // An agent holding unfulfilled branches on why fulfillment failed; a word known
    // only to the gateway would reach a generated client as any string at all.
    const reason = toJsonSchemas().agent_order_status.properties?.reason as
      | { properties: { code: { anyOf: { enum?: string[] }[] } } }
      | undefined;
    const listed = reason?.properties.code.anyOf.flatMap((branch) => branch.enum ?? []);

    expect(listed).toStrictEqual(
      expect.arrayContaining(["deadline_passed", "refused", "price_expired"]),
    );
    const owing = {
      ...status,
      status: "unfulfilled",
      reason: {
        code: "deadline_passed",
        message: "The delivery deadline passed without fulfillment.",
      },
    };
    expect(AgentOrderStatusSchema.parse(owing)).toStrictEqual(owing);
  });

  it("names who sold it, so an agent with a question the order cannot answer knows where to go", () => {
    // The shop's own site is where an agent takes a parcel that did not
    // arrive, a return or the terms of the sale.
    expect(AgentOrderStatusSchema.parse(status).seller).toStrictEqual({
      name: "Freeland",
      site: "https://freeland.example",
    });
  });

  for (const field of [
    "order_id",
    "status",
    "payment_status",
    "price",
    "delivered",
    "test",
    "status_url",
    "seller",
  ]) {
    it(`refuses a status without ${field} and names it`, () => {
      expectMissingFieldRejected(AgentOrderStatusSchema, status, field);
    });
  }

  it("names where the order is collected as an address an agent can call as it stands", () => {
    // The agent that paid for goods that come later holds only this document.
    // A path needs a host the agent was never told, and an address in another
    // scheme is not one an HTTP client can call.
    for (const status_url of [
      "/x402/orders/bk_3f9a1c07d2b84e6a9c5d0e1f2a3b4c5d/status",
      "agentify.ad/x402/orders/bk_3f9a1c07d2b84e6a9c5d0e1f2a3b4c5d/status",
      "ftp://agentify.ad/x402/orders/bk_3f9a1c07d2b84e6a9c5d0e1f2a3b4c5d/status",
    ]) {
      expect(errorOf(AgentOrderStatusSchema, { ...status, status_url }), status_url).toContain(
        "status_url",
      );
    }
    expect(
      AgentOrderStatusSchema.safeParse({
        ...status,
        status_url: "http://localhost:8080/x402/orders/bk_3f9a1c07d2b84e6a9c5d0e1f2a3b4c5d/status",
      }).success,
    ).toBe(true);
  });

  it("carries the rule about that address into the exported document", () => {
    // A rule zod keeps to itself is dropped from the export, so the exported
    // pattern must refuse a bare path too and agree with the schema on every
    // address, scheme in capitals included: a pattern's flags do not survive
    // the export.
    const exported = toJsonSchemas().agent_order_status;

    expect(exported.required).toContain("status_url");
    const property = exported.properties?.status_url;
    const written = typeof property === "object" ? property.pattern : undefined;
    if (written === undefined) {
      throw new Error("the exported document says nothing about what status_url has to look like");
    }
    const pattern = new RegExp(written);
    expect(pattern.test("/x402/orders/bk_3f9a1c07d2b84e6a9c5d0e1f2a3b4c5d/status")).toBe(false);
    expect(pattern.test(status.status_url)).toBe(true);

    for (const status_url of [
      status.status_url,
      "http://localhost:8080/x402/orders/bk_3f9a1c07d2b84e6a9c5d0e1f2a3b4c5d/status",
      "HTTPS://agentify.ad/x402/orders/bk_3f9a1c07d2b84e6a9c5d0e1f2a3b4c5d/status",
      "ftp://agentify.ad/x402/orders/bk_3f9a1c07d2b84e6a9c5d0e1f2a3b4c5d/status",
      "/x402/orders/bk_3f9a1c07d2b84e6a9c5d0e1f2a3b4c5d/status",
    ]) {
      expect(pattern.test(status_url), status_url).toBe(
        AgentOrderStatusSchema.safeParse({ ...status, status_url }).success,
      );
    }
  });

  it("carries the merchant's own words for a refusal they made", () => {
    // `rejected` is coarse because the reason travels here: the merchant's own
    // code and sentence, unchanged.
    const refused = {
      ...status,
      status: "rejected",
      refusal: { code: "out_of_stock", message: "no seats left on that plan" },
    };

    expect(AgentOrderStatusSchema.parse(refused)).toStrictEqual(refused);
  });

  it("takes both words the merchant wrote, and neither of them empty", () => {
    // A field added beside the pair later is read past; that the gateway adds
    // no bookkeeping of its own to a merchant's refusal is held where the
    // status is written.
    for (const pair of [
      { code: "out_of_stock" },
      { message: "no seats left on that plan" },
      { code: "", message: "no seats left on that plan" },
      { code: "out_of_stock", message: "" },
    ]) {
      expect(
        AgentOrderStatusSchema.safeParse({ ...status, refusal: pair }).success,
        JSON.stringify(pair),
      ).toBe(false);
    }
  });

  it("leaves the pair out where nobody refused, rather than sending an empty one", () => {
    // Absent for every ending that is not a merchant's refusal; a blank pair
    // would claim a merchant refused and would not say why.
    expect(AgentOrderStatusSchema.parse(status).refusal).toBeUndefined();
    expect(AgentOrderStatusSchema.safeParse({ ...status, refusal: null }).success).toBe(false);
  });

  it("reads a status word added later as a word, rather than refusing the order", () => {
    // The storefront has no version: an unknown word is read as not an ending
    // the agent knows, and it asks again later rather than losing the whole
    // document. The merchant's own view of the order stays closed.
    expect(
      AgentOrderStatusSchema.safeParse({ ...status, status: "payment_unresolved" }).success,
    ).toBe(true);
    expect(AgentOrderStatusSchema.parse({ ...status, status: "on_hold" }).status).toBe("on_hold");
  });

  it("holds a word added later to the shape of a word", () => {
    // Open, but still a word: no markup, padding or page of text.
    for (const word of ["", " on_hold ", "On_Hold", "<b>held</b>", "w".repeat(65)]) {
      expect(AgentOrderStatusSchema.safeParse({ ...status, status: word }).success, word).toBe(
        false,
      );
    }
  });

  it("takes a field added later, which an agent ignores", () => {
    expect(
      AgentOrderStatusSchema.safeParse({ ...status, estimated_at: "2026-09-30T00:00:00Z" }).success,
    ).toBe(true);
  });

  it("takes a field added later inside any of its parts, not only beside them", () => {
    for (const [part, grown] of [
      ["price", { price: { ...price, tax_included: true } }],
      ["seller", { seller: { ...status.seller, verified_by: "nobody" } }],
      [
        "refusal",
        {
          status: "rejected",
          refusal: { code: "out_of_stock", message: "none left", retry_after: "P1D" },
        },
      ],
      [
        "shipment",
        {
          status: "shipped",
          shipment: {
            carrier: "JNE",
            tracking_number: null,
            shipped_at: "2026-10-08T10:00:00Z",
            signed_for: false,
          },
        },
      ],
      [
        "shipment.estimated_delivery",
        {
          status: "shipped",
          shipment: {
            carrier: "JNE",
            tracking_number: null,
            shipped_at: "2026-10-08T10:00:00Z",
            estimated_delivery: {
              earliest: "2026-10-10T00:00:00Z",
              latest: "2026-10-12T00:00:00Z",
              confidence: "high",
            },
          },
        },
      ],
    ] as const) {
      expect(AgentOrderStatusSchema.safeParse({ ...status, ...grown }).success, part).toBe(true);
    }
  });
});

describe("the catalog an agent reads", () => {
  it("accepts a catalog with cards in it and one with none", () => {
    expect(CatalogPageSchema.safeParse({ items: [publicCard] }).success).toBe(true);
    expect(CatalogPageSchema.parse({ items: [] })).toStrictEqual({ items: [] });
  });

  it("is an object rather than a bare array, so it can grow a way of saying there is more", () => {
    expect(CatalogPageSchema.safeParse([publicCard]).success).toBe(false);
    expect(errorOf(CatalogPageSchema, {})).toContain("items");
  });

  it("is read card by card, so a card an agent cannot read leaves the rest of the page", () => {
    // One card a reader cannot make out is passed over and every other stays
    // for sale.
    const broken = { id: "itm_9a0f11", title: "No price on it" };
    const page = CatalogPageSchema.parse({ items: [publicCard, broken] });

    expect(cardsOf(page)).toStrictEqual([publicCard]);
  });

  it("passes over a card of a mode this contract does not name, however well formed", () => {
    // A reader cannot know when such goods arrive or when money moves, so it
    // must not buy; the rest of the page stands.
    const later = { ...publicCard, fulfillment: "by_appointment" };
    const page = CatalogPageSchema.parse({ items: [later, publicCard] });

    expect(cardsOf(page)).toStrictEqual([publicCard]);
  });

  it("takes a field added later, which an agent ignores", () => {
    expect(CatalogPageSchema.safeParse({ items: [], next_page: "cursor-42" }).success).toBe(true);
  });

  it("says in the exported documents that they take what is added later", () => {
    // A document exported closed would refuse the first field or word added
    // after it, whatever the TypeScript does.
    const exported = toJsonSchemas();
    const known = (property: unknown): unknown[] =>
      ((property as { anyOf?: { enum?: unknown[] }[] }).anyOf ?? []).flatMap(
        (branch) => branch.enum ?? [],
      );

    for (const name of ["catalog_page", "public_card", "agent_order_status"] as const) {
      expect(exported[name].additionalProperties, name).not.toBe(false);
    }
    expect(known(exported.public_card.properties?.fulfillment)).toContain("async");
    expect(known(exported.agent_order_status.properties?.status)).toContain("unfulfilled");
    expect(
      exported.agent_order_status.properties?.status,
      "an open word sits beside the known ones",
    ).toMatchObject({
      anyOf: expect.arrayContaining([expect.objectContaining({ pattern: expect.any(String) })]),
    });
  });
});

describe("the answer a handler returned, on its way back", () => {
  // The promise: whatever a handler returns has an address, in every mode. In
  // synchronous fulfillment the explicit deliver and refuse calls do not
  // apply, so without this route a synchronous refusal would go nowhere.

  const answerRoute: RouteDefinition = API_ROUTES.answer_order;

  /** The body and the answer as the table names them. */
  const body = (): ZodType => {
    expect(answerRoute.request, "the answer route carries no request body").toBeDefined();
    return answerRoute.request ?? z.never();
  };

  const answer = (): ZodType => answerRoute.response.document;

  it("carries each of the three things a handler can return", () => {
    expect(verdictOf(body(), { delivered: { access_url: "https://example.com/a/9f2c4a" } })).toBe(
      "accepted",
    );
    expect(
      verdictOf(body(), { refused: { code: "out_of_stock", message: "Мест на тарифе нет" } }),
    ).toBe("accepted");
    expect(verdictOf(body(), { accepted: {} })).toBe("accepted");
  });

  it("refuses an answer that says two things at once, or nothing", () => {
    // Two would be two answers; none is silence, and silence is a deadline.
    expect(
      verdictOf(body(), {
        delivered: { access_url: "https://example.com/a" },
        refused: { code: "out_of_stock", message: "нет" },
      }),
    ).not.toBe("accepted");
    expect(verdictOf(body(), {})).not.toBe("accepted");
  });

  it("refuses a refusal nobody can count or read", () => {
    // The code is counted toward the missing-product measure; the message is
    // for the person who picks the case up.
    expect(verdictOf(body(), { refused: { message: "нет" } })).not.toBe("accepted");
    expect(verdictOf(body(), { refused: { code: "out_of_stock" } })).not.toBe("accepted");
    expect(verdictOf(body(), { refused: { code: "", message: "нет" } })).not.toBe("accepted");
    expect(verdictOf(body(), { refused: { code: "out_of_stock", message: " " } })).not.toBe(
      "accepted",
    );
  });

  it("refuses a fourth kind of answer", () => {
    // "Not right now" would blur the line a refusal draws; a temporary failure
    // is an exception, and the order comes back.
    expect(verdictOf(body(), { deferred: { retry_after_seconds: 30 } })).not.toBe("accepted");
    expect(verdictOf(body(), { delivered: { access_url: "https://x" }, extra: 1 })).not.toBe(
      "accepted",
    );
  });

  it("tells a late synchronous handler that the work was not wasted", () => {
    // The merchant started before the deadline and finished after it: the
    // goods exist and a repeat purchase collects them, so this is a success
    // word, not a failure code.
    const late = answer().safeParse({ ok: true, result: "purchase_already_closed" });

    expect(late.success ? "accepted" : "refused").toBe("accepted");
    expect((late.data as { ok: boolean }).ok).toBe(true);
    expect(ORDER_CALL_RESULTS).toContain("purchase_already_closed");
    expect(ORDER_CALL_ERROR_CODES).not.toContain("purchase_already_closed");
  });

  it("answers in the same family as the explicit closure calls", () => {
    // One vocabulary of successes and failures across all four calls.
    expect(answer()).toBe(OrderCallResponseSchema);
    expect(
      verdictOf(answer(), {
        ok: false,
        error: {
          code: "order_already_closed",
          message: "Заказ уже закрыт",
          retryable: false,
        },
      }),
    ).toBe("accepted");
  });

  it("is reachable from the registry the way every other document is", () => {
    // The one shape a synchronous merchant needs is reachable through the API.
    expect(body()).toBe(schemas.handler_answer);
    expect(Object.keys(schemas)).toContain("handler_answer");
  });
});

describe("the route table", () => {
  // The promise: the gateway that serves these calls and the SDK that makes
  // them read one description; every check below is a way they could part.

  /** The registry name of a schema, which is how the table is read back. */
  const nameOf = (schema: ZodType | undefined): string => {
    if (schema === undefined) return "-";
    const found = (Object.entries(schemas) as [SchemaName, ZodType][]).find(
      ([, registered]) => registered === schema,
    );
    return found?.[0] ?? "NOT IN THE REGISTRY";
  };

  const responseOf = (route: RouteDefinition): string => nameOf(route.response.document);

  /**
   * The whole surface as it stands, documents included: with only addresses
   * pinned, `get_order` could answer with a plain order and lose the state a
   * restarting worker reads it for.
   */
  const surface: [string, string, string, string, string, string, string][] = [
    // name, method, path, auth, query, request, response
    ["publish_card", "POST", "/v0/catalog/publish", "merchant_key", "-", "card", "publish_result"],
    ["list_merchant_cards", "GET", "/v0/cards", "merchant_key", "-", "-", "merchant_card_list"],
    ["pause_card", "POST", "/v0/cards/:item_id/pause", "merchant_key", "-", "-", "merchant_card"],
    ["resume_card", "POST", "/v0/cards/:item_id/resume", "merchant_key", "-", "-", "merchant_card"],
    ["pause_selling", "POST", "/v0/selling/pause", "merchant_key", "-", "-", "merchant_card_list"],
    [
      "resume_selling",
      "POST",
      "/v0/selling/resume",
      "merchant_key",
      "-",
      "-",
      "merchant_card_list",
    ],
    ["get_seller_name", "GET", "/v0/seller-name", "merchant_key", "-", "-", "seller_name"],
    [
      "set_seller_name",
      "POST",
      "/v0/seller-name",
      "merchant_key",
      "-",
      "seller_name_request",
      "seller_name",
    ],
    ["get_payout_wallet", "GET", "/v0/payout-wallet", "merchant_key", "-", "-", "payout_wallet"],
    ["get_order", "GET", "/v0/orders/:order_id", "merchant_key", "-", "-", "order_with_status"],
    ["list_orders", "GET", "/v0/orders", "merchant_key", "order_list_query", "-", "order_list"],
    ["list_receipts", "GET", "/v0/receipts", "merchant_key", "-", "-", "receipt_list"],
    [
      "poll_worker",
      "POST",
      "/v0/worker/poll",
      "merchant_key",
      "-",
      "worker_poll_request",
      "worker_poll_response",
    ],
    [
      "answer_order",
      "POST",
      "/v0/orders/:order_id/answer",
      "merchant_key",
      "-",
      "handler_answer",
      "order_call_response",
    ],
    [
      "deliver_order",
      "POST",
      "/v0/orders/:order_id/deliver",
      "merchant_key",
      "-",
      "delivery",
      "order_call_response",
    ],
    [
      "close_order",
      "POST",
      "/v0/orders/:order_id/close",
      "merchant_key",
      "-",
      "order_close_request",
      "order_close_response",
    ],
    [
      "refuse_order",
      "POST",
      "/v0/orders/:order_id/refuse",
      "merchant_key",
      "-",
      "refusal",
      "order_call_response",
    ],
    [
      "accept_order",
      "POST",
      "/v0/orders/:order_id/accept",
      "merchant_key",
      "-",
      "acceptance",
      "order_accept_response",
    ],
    [
      "answer_quote",
      "POST",
      "/v0/quotes/:price_id/answer",
      "merchant_key",
      "-",
      "quote_response",
      "quote_answer_ack",
    ],
    ["list_catalog", "GET", "/x402/catalog", "none", "-", "-", "catalog_page"],
    [
      "purchase_item",
      "POST",
      "/x402/:item_id/purchase",
      "none",
      "-",
      "purchase_request",
      "agent_order_status",
    ],
    [
      "get_order_status",
      "GET",
      "/x402/orders/:buyer_key/status",
      "buyer_key",
      "-",
      "-",
      "agent_order_status",
    ],
  ];

  it("carries exactly these calls, at these addresses, with these documents", () => {
    expect(
      (Object.entries(API_ROUTES) as [string, RouteDefinition][]).map(([name, route]) => [
        name,
        route.method,
        route.path,
        route.auth,
        nameOf(route.query),
        nameOf(route.request),
        responseOf(route),
      ]),
    ).toStrictEqual(surface);
  });

  it("names every route the way the wire is written", () => {
    // As in the schema registry: wire names are snake_case.
    for (const name of Object.keys(API_ROUTES)) expect(name, name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("puts no two routes at one address under one method", () => {
    // One of two routes at one address is never reached, depending on mount
    // order.
    const addresses = Object.values(API_ROUTES).map((route) => `${route.method} ${route.path}`);

    expect([...new Set(addresses)]).toHaveLength(addresses.length);
  });

  it("uses only the methods and the doors it declares", () => {
    for (const [name, route] of Object.entries(API_ROUTES)) {
      expect(HTTP_METHODS, name).toContain(route.method);
      expect(AUTH_MODES, name).toContain(route.auth);
    }
  });

  it("refers to no schema the contract does not publish", () => {
    // A reader outside TypeScript has the export and this table; a schema the
    // registry lacks is a call they cannot generate a client for.
    const published = new Set<ZodType>(Object.values(schemas));
    const unpublished: string[] = [];

    for (const [name, route] of Object.entries(API_ROUTES) as [string, RouteDefinition][]) {
      const referenced: [string, ZodType | undefined][] = [
        ["query", route.query],
        ["request", route.request],
        ["response", route.response.document],
      ];

      for (const [what, schema] of referenced) {
        if (schema !== undefined && !published.has(schema)) unpublished.push(`${name}.${what}`);
      }
    }

    expect(unpublished).toStrictEqual([]);
  });

  it("names the document every call answers with, the purchase included", () => {
    // The purchase too: the payment exchange is not a document, but what a
    // paid purchase comes back with is the state of the order.
    for (const [name, route] of Object.entries(API_ROUTES) as [string, RouteDefinition][]) {
      expect(route.response.document, name).toBeDefined();
    }

    expect(API_ROUTES.purchase_item.response.document).toBe(
      API_ROUTES.get_order_status.response.document,
    );
  });

  it("says what every call is for, in words", () => {
    for (const [name, route] of Object.entries(API_ROUTES)) {
      expect(route.description.trim().length, name).toBeGreaterThan(0);
    }
  });

  it("holds every path parameter to a name its own reader can recover", () => {
    // A name outside the path grammar is truncated, not refused: ":productKey"
    // would read as "product" with "Key" left in the address. Comparing with a
    // plain split of the path catches it at build time.
    for (const [name, route] of Object.entries(API_ROUTES)) {
      const written = route.path
        .split("/")
        .filter((segment) => segment.startsWith(":"))
        .map((segment) => segment.slice(1));

      expect(pathParamsOf(route.path), name).toStrictEqual(written);
    }
  });

  it("declares the extra methods an address must answer on as data, not as prose", () => {
    // The purchase address answers the payment challenge on GET too, because
    // validators and crawlers that list a paid resource ask that way; a
    // gateway mounts from data, so it is data here.
    const purchase: RouteDefinition = API_ROUTES.purchase_item;
    expect(purchase.also_answers_on).toStrictEqual(["GET"]);

    for (const [name, route] of Object.entries(API_ROUTES) as [string, RouteDefinition][]) {
      for (const method of route.also_answers_on ?? []) {
        expect(HTTP_METHODS, name).toContain(method);
        expect(method, name).not.toBe(route.method);
      }
    }
  });

  it("leaves a route whose door nobody has chosen out of what a gateway may serve", () => {
    // Mounting "key or open" would serve an undecided route to the world;
    // mounting from this list makes the safe reading the easy one. The gateway
    // keeps its own half: `buildApp` refuses to mount an undecided route.
    for (const [name, route] of mountableRoutes()) expect(route.auth, name).not.toBe("undecided");
  });

  it("names the door on the one route that is the agent's rather than the merchant's", () => {
    // An agent has no merchant key, and `none` would be no door at all: the
    // buyer's key stands in for one, and the word keeps a gateway from reading
    // it as either of the others.
    expect(API_ROUTES.get_order_status.auth).toBe("buyer_key");
    // The route behind that door takes the key and nothing else: an address
    // that also took the order's identifier, which the merchant and the
    // payment side hold, would invite a gateway to answer by it.
    for (const [name, route] of Object.entries(API_ROUTES) as [string, RouteDefinition][]) {
      if (route.auth !== "buyer_key") continue;
      expect(pathParamsOf(route.path), name).toStrictEqual(["buyer_key"]);
    }
  });

  it("keeps the version in the merchant's prefix and out of the storefront's", () => {
    // `/v0` is the merchant's API, versioned for integration code. Storefront
    // addresses are listed in catalogs Agentify does not run and built by
    // strangers, so they carry no version; the protocol versions itself in the
    // challenge. A storefront route under `/v0`, a merchant route where an
    // agent would find it, or `/x402/v1/…` each fail here.
    const storefront: readonly RouteName[] = ["list_catalog", "purchase_item", "get_order_status"];

    for (const [name, route] of Object.entries(API_ROUTES) as [RouteName, RouteDefinition][]) {
      const agents = storefront.includes(name);
      expect(route.path.startsWith(agents ? "/x402/" : "/v0/"), name).toBe(true);
      if (agents) {
        expect(route.path, name).not.toMatch(/\/v\d+(\/|$)/);
      }
    }
  });
});

describe("the addresses in the table, expanded and read back", () => {
  it("names the parameters of a path, and none where there are none", () => {
    expect(pathParamsOf("/v0/orders/:order_id/deliver")).toStrictEqual(["order_id"]);
    expect(pathParamsOf("/x402/catalog")).toStrictEqual([]);
  });

  it("round-trips every route in the table", () => {
    // The promise: the SDK builds any call's address from the table, with
    // nothing left to substitute.
    for (const [name, route] of Object.entries(API_ROUTES)) {
      const parameters = pathParamsOf(route.path);
      const values = Object.fromEntries(parameters.map((parameter) => [parameter, "ord_7c1e05"]));
      const address = expandPath(route.path, values);

      expect(pathParamsOf(address), name).toStrictEqual([]);
      expect(address, name).not.toContain(":");
      for (const parameter of parameters) expect(address, name).not.toContain(parameter);
    }
  });

  it("encodes a value the way a path segment has to be encoded", () => {
    // "SKU 100/1" is a valid identifier; unencoded it is a different route.
    expect(expandPath("/v0/orders/:order_id", { order_id: "SKU 100/1" })).toBe(
      "/v0/orders/SKU%20100%2F1",
    );
  });

  it("refuses to build an address with a hole in it", () => {
    // Otherwise the request goes to a literal ":order_id".
    expect(() => expandPath("/v0/orders/:order_id", {})).toThrow(/order_id/);
    expect(() => expandPath("/v0/orders/:order_id", { order_id: "" })).toThrow(/order_id/);
  });

  it("finds a value only where the caller actually put one", () => {
    // `constructor` fits the parameter grammar and is on Object.prototype;
    // unchecked, it expands into the source of a function.
    expect(() => expandPath("/v0/x/:constructor", {})).toThrow(/constructor/);

    // An inherited value that is a good string still names an order the
    // caller never named.
    const inherited = Object.create({ order_id: "ord_somebody_elses" }) as Record<string, string>;

    expect(Object.hasOwn(inherited, "order_id")).toBe(false);
    expect(inherited.order_id).toBe("ord_somebody_elses");
    expect(() => expandPath("/v0/orders/:order_id", inherited)).toThrow(/order_id/);
  });

  it("refuses a value that is a step through the path rather than a value in it", () => {
    // ".." survives encoding and a URL resolver walks it, and an identifier
    // may be "..".
    expect(() => expandPath("/v0/orders/:order_id", { order_id: ".." })).toThrow(/order_id/);
    expect(() => expandPath("/v0/orders/:order_id", { order_id: "." })).toThrow(/order_id/);
  });

  it("refuses a value that is not text, rather than spelling it out", () => {
    // Callers of the SDK may not have the types; `null` stringified would be a
    // real-looking address.
    const wrong = { order_id: null } as unknown as Record<string, string>;
    const alsoWrong = { order_id: 5 } as unknown as Record<string, string>;

    expect(() => expandPath("/v0/orders/:order_id", wrong)).toThrow(/order_id/);
    expect(() => expandPath("/v0/orders/:order_id", alsoWrong)).toThrow(/order_id/);
  });

  it("refuses a value for something the address does not take", () => {
    // `orderId` for `order_id` is a bug, and dropping it would send a request
    // that does something else.
    expect(() =>
      expandPath("/v0/orders/:order_id", { order_id: "ord_1", orderId: "ord_2" }),
    ).toThrow(/orderId/);
    expect(() => expandPath("/x402/catalog", { order_id: "ord_1" })).toThrow(/order_id/);
  });
});

/**
 * The merchant key's header, which the route table does not carry: held in
 * one place, so a mismatch between gateway and SDK breaks a test rather than
 * a merchant's worker with an authorisation error.
 */
describe("the merchant key's header, held in one place so both sides cannot drift", () => {
  it("names the header the key travels in and the value that carries it", () => {
    expect(MERCHANT_KEY_HEADER).toBe("authorization");
    expect(merchantKeyHeaderValue("a-merchant-key-long-enough")).toBe(
      "Bearer a-merchant-key-long-enough",
    );
  });

  it("takes back out exactly the key the value was built around", () => {
    // Whatever the SDK puts in, the gateway reads the same key out; a key has
    // no whitespace, and every other likely character survives.
    for (const key of ["k", "a-merchant-key-long-enough", "sk.live_9-1/ABCxyz+42="]) {
      expect(merchantKeyFrom(merchantKeyHeaderValue(key))).toBe(key);
    }
  });

  it("reads the scheme however it is cased, because an auth scheme is case-insensitive", () => {
    // An auth scheme is case-insensitive (RFC 7235 §2.1), and "bearer" holds a
    // correct key.
    expect(merchantKeyFrom("Bearer abc")).toBe("abc");
    expect(merchantKeyFrom("bearer abc")).toBe("abc");
    expect(merchantKeyFrom("  Bearer\tabc  ")).toBe("abc");
  });

  it("returns null for anything that is not one of our bearer tokens", () => {
    // The negative control: anything that is not a key this contract issued
    // reads as no key, never as a half-parsed string that could match a prefix
    // of the real one.
    expect(merchantKeyFrom(undefined)).toBeNull(); // no header at all
    expect(merchantKeyFrom("")).toBeNull(); // an empty value
    expect(merchantKeyFrom("abc")).toBeNull(); // no scheme, just a token
    expect(merchantKeyFrom("Basic abc")).toBeNull(); // another scheme entirely
    expect(merchantKeyFrom("Bearer")).toBeNull(); // the scheme with no token
    expect(merchantKeyFrom("Bearer   ")).toBeNull(); // the scheme and only spaces
  });
});

describe("the envelope every call refuses in", () => {
  const refused = {
    error: { code: "no_such_order", message: "there is no such order", retryable: false },
  };

  it("accepts a refusal with a code, words and the answer about calling again", () => {
    expect(ErrorEnvelopeSchema.parse(refused)).toStrictEqual(refused);
  });

  for (const field of ["code", "message", "retryable"]) {
    it(`refuses one with no ${field}, and says which is missing`, () => {
      // A refusal without a code cannot be branched on, without words cannot
      // be read, and without the retry answer leaves the caller guessing
      // between a loop and an abandoned call.
      const without = Object.fromEntries(
        Object.entries(refused.error).filter(([name]) => name !== field),
      );

      expect(errorOf(ErrorEnvelopeSchema, { error: without })).toContain(field);
    });
  }

  it("refuses a code or a sentence that is there and says nothing", () => {
    // Blank is the absence wearing the field's name.
    expect(errorOf(ErrorEnvelopeSchema, { error: { ...refused.error, code: "  " } })).toContain(
      "code",
    );
    expect(errorOf(ErrorEnvelopeSchema, { error: { ...refused.error, message: "" } })).toContain(
      "explanation",
    );
  });

  it("refuses an answer about calling again that is not an answer", () => {
    // Two values and no third: "maybe" read as true is the retry loop this
    // field exists to prevent.
    for (const said of ["false", 0, null, "maybe"]) {
      expect(
        ErrorEnvelopeSchema.safeParse({ error: { ...refused.error, retryable: said } }).success,
        JSON.stringify(said),
      ).toBe(false);
    }
  });

  it("lets a refusal say more about itself, beside the three that are always there", () => {
    // Some refusals add detail, such as where an order ended or which fields
    // did not fit; a reader that does not know it still reads the three.
    for (const detail of [
      { status: "rejected" },
      { problems: [{ path: ["params", "email"], code: "required", message: "missing" }] },
    ]) {
      const parsed = ErrorEnvelopeSchema.parse({ error: { ...refused.error, ...detail } });

      expect(parsed.error).toMatchObject(detail);
      expect(parsed.error.code).toBe(refused.error.code);
    }
  });

  it("is not a document that merely mentions an error", () => {
    // The negative control: an envelope matching anything with an `error` in
    // it would turn a route's own document into a failed call.
    expect(
      ErrorEnvelopeSchema.safeParse({ ok: false, error: { code: "x", message: "y" } }).success,
    ).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ errors: [] }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ order_id: "ord_7c1e05" }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse("a proxy's error page").success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse(null).success).toBe(false);
  });

  it("is refused by every route's own document, so recognising one cannot swallow an answer", () => {
    // The SDK reads an answer as a refusal when the route's document will not
    // have it, which is safe only while no document accepts an envelope; this
    // is where that is checked.
    for (const [name, route] of Object.entries(API_ROUTES) as [string, RouteDefinition][]) {
      expect(
        route.response.document.safeParse(refused).success,
        `${name} answers with a document that accepts a refusal envelope, so a refusal to this call cannot be told from an answer to it`,
      ).toBe(false);
    }
  });

  it("accepts a code the published list has never heard of", () => {
    // The list is for switching over, not for validating: a client one
    // version behind would otherwise fail to read a refusal at all.
    const unfamiliar = {
      error: { code: "something_nobody_has_named_yet", message: "and yet", retryable: false },
    };

    expect(ErrorEnvelopeSchema.parse(unfamiliar)).toStrictEqual(unfamiliar);
    expect(ERROR_CODES).not.toContain("something_nobody_has_named_yet");
  });

  it("has no code written down twice", () => {
    // A duplicate would mislead a reader counting what this surface can say.
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("is published, because it is the one answer every caller has to be able to read", () => {
    // A reader with only the export must be able to tell a call failed.
    expect(schemas.error_envelope).toBe(ErrorEnvelopeSchema);
  });
});
