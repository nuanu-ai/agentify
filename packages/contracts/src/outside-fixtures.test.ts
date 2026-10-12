/**
 * The contract run against a real merchant's catalog rather than the
 * documentation's example: a rented phone number sold synchronously, an eSIM
 * plan whose profile arrives later, and a VPN subscription at a fixed price.
 *
 * Taken from the merchant's API: the three products and their modes, the
 * number's price of $8.75 (supplier cost plus a markup) and its documented
 * limits, the VPN's $5 a month and its single subscription link, the eSIM
 * delivery fields (ICCID, the LPA string, the iOS link) and the supplier
 * running out of profiles.
 *
 * Constructed, and this list is the whole of it: the eSIM plan's price of
 * $18.90, its identifier, title, description and delivery deadline of 900
 * seconds; the phone number's `phone_number` result field, whose exact shape
 * the merchant's API leaves open; and every identifier, timestamp and title on
 * this page. They are plausible and none is a quotation.
 *
 * One purchase is walked end to end, from card to receipt and the event that
 * follows a delivery that did not happen, and then the same products across
 * the HTTP surface.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  API_ROUTES,
  CatalogPageSchema,
  expandPath,
  OrderAcceptResponseSchema,
  OrderCallResponseSchema,
  OrderListSchema,
  OrderWithStatusSchema,
  PurchaseRequestSchema,
  QuoteAnswerAckSchema,
  type RouteDefinition,
  WorkerPollResponseSchema,
} from "./api.js";
import { CardSchema, deliveryCheckFor, publicCardOf, purchaseCheckFor } from "./card.js";
import { OrderEventSchema } from "./events.js";
import { AcceptanceSchema, HandlerAnswerSchema } from "./handler.js";
import { CONTRACT_VERSION } from "./index.js";
import { OrderSchema } from "./order.js";

import { QuoteRequestSchema, QuoteResponseSchema } from "./quote.js";
import { ReceiptSchema } from "./receipt.js";

/**
 * Whether the schema accepts the value and, when it does not, why, so a
 * failure names the field instead of "expected false to be true".
 */
const verdictOf = (schema: z.ZodType, value: unknown): string => {
  const result = schema.safeParse(value);
  return result.success ? "accepted" : `refused: ${z.prettifyError(result.error)}`;
};

/**
 * The body a route takes, insisted on: `route.request ?? SomeSchema` would go
 * on passing against a table that had lost the body.
 */
const bodyOf = (route: RouteDefinition): z.ZodType => {
  expect(route.request, `${route.method} ${route.path} carries no request body`).toBeDefined();
  return route.request ?? z.never();
};

/**
 * The three products, declared once and read by every section, so that a
 * change to one is a change everywhere.
 */

const numberCard = {
  merchant_item_id: "virtual-number-monthly",
  title: "Виртуальный номер на месяц",
  description:
    "Номер в выбранной стране на 30 дней. Только входящие SMS; совместимость с одноразовыми кодами зависит от отправителя.",
  price: { amount: "8.75", currency: "USD" },
  params: {
    country: { type: "string", required: true, title: "Страна номера, ISO 3166-1 alpha-2" },
    period: { type: "string", required: true, title: "MONTHLY, 90, 180 или YEAR" },
  },
  result: {
    phone_number: { type: "string", title: "Номер в формате E.164" },
  },
  fulfillment: "sync",
  price_check: "handler",
};

const esimCard = {
  merchant_item_id: "esim-europe-10gb-30d",
  title: "eSIM: Европа, 10 ГБ на 30 дней",
  description: "Профиль eSIM с покрытием в странах Европы. Активация после установки профиля.",
  price: { amount: "18.90", currency: "USD" },
  result: {
    iccid: { type: "string", title: "ICCID профиля" },
    qr_data: { type: "string", title: "Строка LPA для QR-кода" },
    ios_tap_link: { type: "string", title: "Ссылка установки для iOS" },
  },
  fulfillment: "async",
  price_check: "handler",
  fulfill_deadline_seconds: 900,
};

const vpnCard = {
  merchant_item_id: "vpn-monthly",
  title: "VPN на месяц",
  description: "Подписка на 30 дней. Выдаётся ссылка подписки, одна на все устройства.",
  price: { amount: "5", currency: "USDT" },
  result: {
    subscription_url: { type: "string", title: "Ссылка подписки" },
  },
  fulfillment: "sync",
};

describe("a rented phone number, sold synchronously", () => {
  // The price is the supplier's cost plus a markup, so it is asked at
  // purchase; "no SIM available" is a refusal before any money moves.
  const card = numberCard;

  it("is a card an agent can buy from", () => {
    expect(verdictOf(CardSchema, card)).toBe("accepted");
  });

  it("checks a purchase against what the card declared", () => {
    // Through the card, the only place that knows which declaration is which.
    const check = purchaseCheckFor(CardSchema.parse(card));

    expect(verdictOf(check, { country: "GB", period: "MONTHLY" })).toBe("accepted");
    expect(verdictOf(check, { country: "GB" })).not.toBe("accepted");
    expect(verdictOf(check, { country: "GB", period: "MONTHLY", service: "telegram" })).not.toBe(
      "accepted",
    );
  });

  it("holds the delivery to the result the card advertised", () => {
    const check = deliveryCheckFor(CardSchema.parse(card));

    expect(verdictOf(check, { phone_number: "+447700900123" })).toBe("accepted");
    expect(verdictOf(check, {})).not.toBe("accepted");
  });

  it("asks for a price and gets one back", () => {
    const question = {
      merchant_item_id: card.merchant_item_id,
      params: { country: "GB", period: "MONTHLY" },
      price_id: "prc_5d10ab",
      purpose: "purchase",
      expires_at: "2026-08-26T12:05:00Z",
    };
    const answer = {
      available: true,
      price: { amount: "8.75", currency: "USD" },
      as_of: "2026-08-26T12:00:00Z",
    };

    expect(verdictOf(QuoteRequestSchema, question)).toBe("accepted");
    expect(verdictOf(QuoteResponseSchema, answer)).toBe("accepted");
  });

  it("reaches the handler as an order and comes back as a delivery", () => {
    const order = {
      id: "ord_1c42fa",
      merchant_item_id: card.merchant_item_id,
      params: { country: "GB", period: "MONTHLY" },
      price: {
        amount: "8.75",
        currency: "USD",
        at: "2026-08-26T12:00:04Z",
        as_of: "2026-08-26T12:00:00Z",
      },
      price_id: "prc_5d10ab",
      test: false,
    };

    expect(verdictOf(OrderSchema, order)).toBe("accepted");
    expect(verdictOf(HandlerAnswerSchema, { delivered: { phone_number: "+447700900123" } })).toBe(
      "accepted",
    );

    // Their supplier answering "no SIM" is a refusal, and in this mode the
    // buyer spends nothing.
    expect(
      verdictOf(HandlerAnswerSchema, {
        refused: { code: "out_of_stock", message: "Свободных номеров в этой стране нет" },
      }),
    ).toBe("accepted");
  });
});

describe("an eSIM plan, whose profile arrives later", () => {
  // The purchase names a plan and nothing else, so the card takes no
  // parameters: a case the documentation's example never exercises.
  const card = esimCard;

  it("is a card with no purchase parameters and a delivery deadline of its own", () => {
    expect(verdictOf(CardSchema, card)).toBe("accepted");
  });

  it("takes the order on first and delivers afterwards", () => {
    const order = {
      id: "ord_88b3c1",
      merchant_item_id: card.merchant_item_id,
      params: {},
      price: {
        amount: "18.90",
        currency: "USD",
        at: "2026-08-26T12:10:00Z",
        as_of: "2026-08-26T12:09:58Z",
      },
      price_id: "prc_77aa04",
      test: false,
    };

    expect(verdictOf(OrderSchema, order)).toBe("accepted");
    expect(verdictOf(HandlerAnswerSchema, { accepted: {} })).toBe("accepted");
  });

  it("leaves a receipt from the moment the money moves, before the profile exists", () => {
    const receipt = {
      id: "rcp_2f60ce",
      order_id: "ord_88b3c1",
      item_id: "itm_4d21bb",
      price: {
        amount: "18.90",
        currency: "USD",
        at: "2026-08-26T12:10:00Z",
        as_of: "2026-08-26T12:09:58Z",
      },
      price_id: "prc_77aa04",
      paid_at: "2026-08-26T12:10:01Z",
      outcome: "in_progress",
      test: false,
    };

    expect(verdictOf(ReceiptSchema, receipt)).toBe("accepted");
  });

  it("turns into a refund owed when the supplier has no SIM left", () => {
    // A refusal after the money moved: the merchant hears both the refusal
    // and the debt it created.
    expect(
      verdictOf(HandlerAnswerSchema, {
        refused: { code: "out_of_stock", message: "У поставщика не осталось профилей этого плана" },
      }),
    ).toBe("accepted");

    expect(
      verdictOf(OrderEventSchema, {
        type: "order.refund_due",
        order_id: "ord_88b3c1",
        at: "2026-08-26T12:11:30Z",
        price: { amount: "18.90", currency: "USD" },
        reason: "refused",
      }),
    ).toBe("accepted");
  });
});

describe("a VPN subscription at a price that does not move", () => {
  // A fixed price: no price check, no deadlines, and no price_id on the order.
  const card = vpnCard;

  it("is a complete card without a price check", () => {
    expect(verdictOf(CardSchema, card)).toBe("accepted");
  });

  it("produces an order with no price question behind it", () => {
    const order = {
      id: "ord_9ae107",
      merchant_item_id: card.merchant_item_id,
      params: {},
      price: {
        amount: "5",
        currency: "USDT",
        at: "2026-08-26T12:30:00Z",
        // Sold from the card, so this is when its price was last published.
        as_of: "2026-08-20T09:00:00Z",
      },
      test: false,
    };

    expect(verdictOf(OrderSchema, order)).toBe("accepted");
  });

  it("closes with a receipt that says the delivery happened", () => {
    const receipt = {
      id: "rcp_0b7712",
      order_id: "ord_9ae107",
      item_id: "itm_6c0f39",
      price: {
        amount: "5",
        currency: "USDT",
        at: "2026-08-26T12:30:00Z",
        as_of: "2026-08-20T09:00:00Z",
      },
      paid_at: "2026-08-26T12:30:02Z",
      outcome: "delivered",
      test: false,
    };

    expect(verdictOf(ReceiptSchema, receipt)).toBe("accepted");
  });
});

describe("the HTTP surface, carrying this catalog rather than the portal's", () => {
  // The three products through the route table and the envelope, as a real
  // day would move them: published, listed, drawn off the stream, answered.

  const number = CardSchema.parse(numberCard);
  const esim = CardSchema.parse(esimCard);
  const vpn = CardSchema.parse(vpnCard);

  const esimOrder = {
    id: "ord_88b3c1",
    merchant_item_id: "esim-europe-10gb-30d",
    params: {},
    price: {
      amount: "18.90",
      currency: "USD",
      at: "2026-08-26T12:10:00Z",
      as_of: "2026-08-26T12:09:58Z",
    },
    price_id: "prc_77aa04",
    test: false,
  };

  it("shows all three products to an agent without showing how the merchant is asked for a price", () => {
    const seller = { name: "Freeland", site: null };
    const catalog = {
      items: [
        publicCardOf(number, { id: "itm_1a00b2", as_of: "2026-08-26T09:00:00Z", seller }),
        publicCardOf(esim, { id: "itm_4d21bb", as_of: "2026-08-26T09:00:00Z", seller }),
        publicCardOf(vpn, { id: "itm_6c0f39", as_of: "2026-08-20T09:00:00Z", seller }),
      ],
    };

    expect(verdictOf(CatalogPageSchema, catalog)).toBe("accepted");

    // The two with a price check say so; the fixed-price VPN says it does not.
    expect(catalog.items.map((item) => item.price_checked_at_purchase)).toStrictEqual([
      true,
      true,
      false,
    ]);
    // Their own keys stay theirs, and the delivery deadline reaches the agent
    // only on the product whose mode has one.
    for (const item of catalog.items) expect(Object.keys(item)).not.toContain("merchant_item_id");
    expect(catalog.items.map((item) => "fulfill_deadline_seconds" in item)).toStrictEqual([
      false,
      true,
      false,
    ]);
  });

  it("carries an order, a price question and an event down one worker stream", () => {
    const batch = {
      contract_version: CONTRACT_VERSION,
      envelopes: [
        {
          kind: "quote_request",
          id: "msg_31ba07",
          sent_at: "2026-08-26T12:00:00Z",
          payload: {
            merchant_item_id: "virtual-number-monthly",
            params: { country: "GB", period: "MONTHLY" },
            price_id: "prc_5d10ab",
            purpose: "purchase",
            expires_at: "2026-08-26T12:05:00Z",
          },
        },
        {
          kind: "order",
          id: "msg_9c4410",
          sent_at: "2026-08-26T12:10:01Z",
          payload: esimOrder,
        },
        {
          kind: "order_event",
          id: "msg_02de55",
          sent_at: "2026-08-26T12:26:00Z",
          payload: {
            type: "order.refund_due",
            order_id: "ord_88b3c1",
            at: "2026-08-26T12:26:00Z",
            price: { amount: "18.90", currency: "USD" },
            reason: "deadline_passed",
          },
        },
      ],
    };

    expect(verdictOf(WorkerPollResponseSchema, batch)).toBe("accepted");
  });

  it("answers the price question at the address the table names for it", () => {
    const address = expandPath(API_ROUTES.answer_quote.path, { price_id: "prc_5d10ab" });

    expect(address).toBe("/v0/quotes/prc_5d10ab/answer");
    expect(
      verdictOf(bodyOf(API_ROUTES.answer_quote), {
        available: true,
        price: { amount: "8.75", currency: "USD" },
        as_of: "2026-08-26T12:00:00Z",
      }),
    ).toBe("accepted");
    expect(verdictOf(QuoteAnswerAckSchema, { used: true })).toBe("accepted");
  });

  it("returns the rented number from a synchronous handler, at the address the table names", () => {
    // In synchronous fulfillment the handler's return is the delivery and the
    // refusal, sent to the answer route; deliver and refuse do not apply.
    const address = expandPath(API_ROUTES.answer_order.path, { order_id: "ord_1c42fa" });
    const delivered = { phone_number: "+447700900123" };

    expect(address).toBe("/v0/orders/ord_1c42fa/answer");
    expect(verdictOf(bodyOf(API_ROUTES.answer_order), { delivered })).toBe("accepted");
    // The same answer is held to what this card advertised before anyone paid.
    expect(verdictOf(deliveryCheckFor(number), delivered)).toBe("accepted");

    // Their supplier answering "no SIM" travels the same way, and in this mode
    // the buyer spends nothing.
    expect(
      verdictOf(bodyOf(API_ROUTES.answer_order), {
        refused: { code: "out_of_stock", message: "Свободных номеров в этой стране нет" },
      }),
    ).toBe("accepted");

    // A handler that started in time and finished late is told the work was
    // not wasted.
    expect(
      verdictOf(OrderCallResponseSchema, { ok: true, result: "purchase_already_closed" }),
    ).toBe("accepted");
  });

  it("takes the eSIM order on and then delivers it, at the addresses the table names", () => {
    expect(expandPath(API_ROUTES.accept_order.path, { order_id: esimOrder.id })).toBe(
      "/v0/orders/ord_88b3c1/accept",
    );
    expect(expandPath(API_ROUTES.deliver_order.path, { order_id: esimOrder.id })).toBe(
      "/v0/orders/ord_88b3c1/deliver",
    );

    expect(verdictOf(AcceptanceSchema, {})).toBe("accepted");
    expect(verdictOf(OrderAcceptResponseSchema, { ok: true })).toBe("accepted");

    const delivered = {
      iccid: "8944500000000000000",
      qr_data: "LPA:1$rsp.example.com$0A1B2C3D",
      ios_tap_link:
        "https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=LPA:1$rsp.example.com$0A1B2C3D",
    };

    // The surface's document and the card's compiled check must agree about
    // the delivery.
    expect(verdictOf(bodyOf(API_ROUTES.deliver_order), delivered)).toBe("accepted");
    expect(verdictOf(deliveryCheckFor(esim), delivered)).toBe("accepted");
    expect(verdictOf(OrderCallResponseSchema, { ok: true, result: "delivered" })).toBe("accepted");
  });

  it("refuses the supplier's empty stock as a failure the merchant can act on", () => {
    // In this mode the money has already moved, so the refusal succeeds and
    // the debt arrives as an event; a second attempt after the refund was paid
    // out fails as not worth retrying.
    expect(
      verdictOf(bodyOf(API_ROUTES.refuse_order), {
        code: "out_of_stock",
        message: "У поставщика не осталось профилей этого плана",
      }),
    ).toBe("accepted");
    expect(verdictOf(OrderCallResponseSchema, { ok: true, result: "refused" })).toBe("accepted");
    expect(
      verdictOf(OrderCallResponseSchema, {
        ok: false,
        error: {
          code: "refund_already_settled",
          message: "Возврат по этому заказу уже исполнен",
          retryable: false,
        },
      }),
    ).toBe("accepted");
  });

  it("reads the same order back with the state it is in", () => {
    expect(expandPath(API_ROUTES.get_order.path, { order_id: esimOrder.id })).toBe(
      "/v0/orders/ord_88b3c1",
    );
    expect(verdictOf(OrderWithStatusSchema, { ...esimOrder, status: "refund_due" })).toBe(
      "accepted",
    );
    expect(
      verdictOf(OrderListSchema, { orders: [{ ...esimOrder, status: "delivered_unpaid" }] }),
    ).toBe("accepted");
  });

  it("buys the rented number at the address the table names, with the card's own parameters", () => {
    const address = expandPath(API_ROUTES.purchase_item.path, { item_id: "itm_1a00b2" });
    const purchase = { params: { country: "GB", period: "MONTHLY" } };

    expect(address).toBe("/x402/itm_1a00b2/purchase");
    expect(verdictOf(PurchaseRequestSchema, purchase)).toBe("accepted");
    // The table's document holds the envelope; the card holds the contents.
    expect(verdictOf(purchaseCheckFor(number), purchase.params)).toBe("accepted");
    expect(verdictOf(purchaseCheckFor(number), { country: "GB" })).not.toBe("accepted");
  });
});
