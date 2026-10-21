/**
 * What a reader of the merchant's answers makes of a gateway newer than
 * itself: a field it was not built with is ignored at any depth, a status word
 * it does not know reads `unknown`, and an event of a kind it does not know
 * comes through marked so that it can be skipped. What it still refuses is a
 * document missing what it needs.
 */

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import {
  API_ROUTES,
  MerchantCardListSchema,
  OrderCallResponseSchema,
  OrderListSchema,
  OrderWithStatusSchema,
  ReceiptListSchema,
  WorkerPollResponseSchema,
} from "./api.js";
import { CONTRACT_VERSION } from "./index.js";
import { readerOf } from "./reading.js";

const AT = "2026-08-26T10:20:00Z";

const order = {
  id: "ord_7c1e05",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: { amount: "5.00", currency: "USD", at: AT, as_of: AT },
  price_id: "prc_31a8c0",
  test: false,
};

const parcel = {
  ...order,
  ship_to: {
    name: "Ni Made Ayu",
    line_one: "Jl. Raya Kediri 12",
    city: "Tabanan",
    country: "ID",
    phone_number: "+62 812 0000 0000",
  },
};

const read = { ...parcel, status: "fulfillment_closed", payment_status: "not_paid" };

const closedRead = {
  ...read,
  merchant_closure: { closed_at: AT, message: "Out of stock for the season." },
};

const unfulfilled = {
  type: "order.unfulfilled",
  order_id: "ord_7c1e05",
  at: AT,
  price: { amount: "5.00", currency: "USD" },
  reason: "deadline_passed",
};

const poll = {
  contract_version: CONTRACT_VERSION,
  envelopes: [
    { kind: "order", id: "msg_1", sent_at: AT, payload: parcel },
    {
      kind: "quote_request",
      id: "msg_2",
      sent_at: AT,
      payload: {
        merchant_item_id: "access-monthly",
        price_id: "prc_31a8c0",
        purpose: "purchase",
        expires_at: AT,
      },
    },
    { kind: "order_event", id: "msg_3", sent_at: AT, payload: unfulfilled },
  ],
};

const cards = {
  selling: "open",
  cards: [
    {
      id: "itm_4d21bb",
      as_of: AT,
      card: {
        merchant_item_id: "access-monthly",
        title: "One month of access",
        description: "Thirty days of access from the moment it is issued.",
        price: { amount: "5.00", currency: "USD" },
        params: { email: { type: "string", required: true, title: "Where access goes" } },
        result: { access_url: { type: "string" } },
        fulfillment: "sync",
      },
      selling: "open",
      paused: false,
    },
  ],
};

const receipts = {
  receipts: [
    {
      id: "rcp_4b90de",
      order_id: "ord_7c1e05",
      item_id: "itm_9f2c4a",
      price: { amount: "5.00", currency: "USD", at: AT, as_of: AT },
      paid_at: AT,
      outcome: "delivered",
      test: false,
    },
  ],
};

const refused = {
  ok: false,
  error: { code: "order_already_closed", message: "Nothing to deliver.", retryable: false },
};

const ANSWERS: readonly (readonly [string, ZodType, unknown])[] = [
  ["an order read back", OrderWithStatusSchema, closedRead],
  ["the order list", OrderListSchema, { orders: [read, closedRead] }],
  ["a poll answer", WorkerPollResponseSchema, poll],
  ["the merchant's cards", MerchantCardListSchema, cards],
  ["the receipts", ReceiptListSchema, receipts],
  ["an order call that worked", OrderCallResponseSchema, { ok: true, result: "delivered" }],
  ["an order call that was refused", OrderCallResponseSchema, refused],
];

type Node = Record<string, unknown>;

/** The path to every plain object inside a document, the document itself included. */
const objectsIn = (
  node: unknown,
  path: readonly (string | number)[] = [],
): (string | number)[][] => {
  if (Array.isArray(node)) return node.flatMap((each, index) => objectsIn(each, [...path, index]));
  if (typeof node !== "object" || node === null) return [];
  return [
    [...path],
    ...Object.entries(node).flatMap(([key, value]) => objectsIn(value, [...path, key])),
  ];
};

/** The document as a newer gateway might send it: one field added at this path. */
const addedAt = (document: unknown, path: readonly (string | number)[]): unknown => {
  const copy = structuredClone(document) as Node;
  let at: Node = copy;
  for (const key of path) at = at[key] as Node;
  at.added_later = { carried: true };
  return copy;
};

describe("a reader of the merchant's answers", () => {
  it("reads an answer with a field added at any depth as the answer without it", () => {
    for (const [name, schema, answer] of ANSWERS) {
      // The premise: each answer is one this gateway may send today.
      const today = schema.safeParse(answer);
      expect(today.success, name).toBe(true);

      // The names inside an order's parameters and a card's declarations are
      // the card's own, so a name added there is a parameter, not a field.
      const places = objectsIn(answer).filter(
        (path) => !path.includes("params") && !path.includes("result"),
      );
      expect(places.length, name).toBeGreaterThan(0);

      for (const path of places) {
        const newer = addedAt(answer, path);
        // The writing contract stays shut: the same field from this gateway
        // is a leak, and its own check refuses it.
        expect(schema.safeParse(newer).success, `${name} at ${path.join(".")}`).toBe(false);
        expect(readerOf(schema).parse(newer), `${name} at ${path.join(".")}`).toStrictEqual(
          today.data,
        );
      }
    }
  });

  it("reads a status or a payment word it does not know as unknown, and a known one as itself", () => {
    const reader = readerOf(OrderWithStatusSchema);

    expect(reader.parse({ ...read, status: "on_hold" }).status).toBe("unknown");
    expect(reader.parse({ ...read, payment_status: "partly_refunded" }).payment_status).toBe(
      "unknown",
    );
    expect(reader.parse(read)).toMatchObject({
      status: "fulfillment_closed",
      payment_status: "not_paid",
    });
    expect(
      readerOf(OrderListSchema).parse({ orders: [{ ...read, status: "on_hold" }] }),
    ).toMatchObject({ orders: [{ id: order.id, status: "unknown" }] });
  });

  it("marks an event of a kind it does not know, naming the kind, and reads the rest of the poll", () => {
    const newer = {
      ...poll,
      envelopes: [
        {
          kind: "order_event",
          id: "msg_0",
          sent_at: AT,
          payload: { type: "order.refunded", order_id: "ord_7c1e05", at: AT },
        },
        ...poll.envelopes,
      ],
    };

    const parsed = readerOf(WorkerPollResponseSchema).parse(newer);

    expect(parsed.envelopes.map((envelope) => envelope.payload)).toStrictEqual([
      { type: "unknown", named: "order.refunded" },
      parcel,
      poll.envelopes[1]?.payload,
      unfulfilled,
    ]);
  });

  it("reads no route's answer out of the gateway's refusal, so a refusal never passes for a success", () => {
    // A reader that ignores unknown fields would take a document whose fields
    // are all optional out of any object at all, the refusal included.
    const refusal = {
      error: { code: "no_such_order", message: "No such order.", retryable: false },
    };

    for (const [name, route] of Object.entries(API_ROUTES)) {
      expect(readerOf(route.response.document).safeParse(refusal).success, name).toBe(false);
    }
  });

  it("still refuses an answer missing a field it needs, or a status that is not a word", () => {
    // The negative control: ignoring what was added is not accepting anything.
    const { id: _id, ...nameless } = read;
    expect(readerOf(OrderWithStatusSchema).safeParse(nameless).success).toBe(false);
    const { status: _status, ...wordless } = read;
    expect(readerOf(OrderWithStatusSchema).safeParse(wordless).success).toBe(false);
    expect(readerOf(OrderWithStatusSchema).safeParse({ ...read, status: 7 }).success).toBe(false);
    expect(
      readerOf(WorkerPollResponseSchema).safeParse({ ...poll, contract_version: "" }).success,
    ).toBe(false);
  });
});
