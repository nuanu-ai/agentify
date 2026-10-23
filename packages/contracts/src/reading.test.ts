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

/** An address in a shape this reader does not know: a carrier's pickup point. */
const pickup = {
  pickup_point_id: "pp_4411",
  carrier: "JNE",
  city: "Tabanan",
  country: "ID",
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
  // Copied apart, since the two share their price and a field added to one
  // must not land in the other.
  ["the order list", OrderListSchema, { orders: [read, structuredClone(closedRead)] }],
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

/**
 * Whether a path lies in what an order delivers: the order itself and every
 * part of it, off the stream or read back. The status words and the merchant's
 * closure beside them only inform.
 */
const deliversAt = (name: string, path: readonly (string | number)[]): boolean => {
  const inOrder = (at: readonly (string | number)[]) =>
    at.length === 0 || at[0] === "price" || at[0] === "ship_to";
  if (name === "an order read back") return inOrder(path);
  if (name === "the order list") return path.length >= 2 && inOrder(path.slice(2));
  if (name === "a poll answer") return path[1] === 0 && path[2] === "payload";
  return false;
};

/** What a reader makes of the first envelope of a poll answer. */
const firstEnvelopeOf = (answer: unknown): unknown =>
  readerOf(WorkerPollResponseSchema).parse(answer).envelopes[0];

describe("a reader of the merchant's answers", () => {
  it("reads an answer with an informational field added at any depth as the answer without it, and never reads an order with a field added to what it delivers", () => {
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
        if (name === "a poll answer" && deliversAt(name, path)) {
          // On the stream the order is marked unread and the answer around it
          // is still read, so one order cannot hold up what came with it.
          expect(firstEnvelopeOf(newer), `${name} at ${path.join(".")}`).toMatchObject({
            kind: "unknown",
            named: "order",
            subject: parcel.id,
          });
        } else if (name === "the order list" && deliversAt(name, path)) {
          // In a list the order is marked unread and the orders beside it are
          // still read, so one order cannot hide the rest.
          const listed = readerOf(OrderListSchema).parse(newer).orders;
          expect(listed[Number(path[1])], `${name} at ${path.join(".")}`).toMatchObject({
            kind: "unknown",
            subject: read.id,
          });
          expect(
            listed.filter((one) => !("issues" in one)),
            `${name} at ${path.join(".")}`,
          ).toHaveLength(1);
        } else if (deliversAt(name, path)) {
          expect(readerOf(schema).safeParse(newer).success, `${name} at ${path.join(".")}`).toBe(
            false,
          );
        } else {
          expect(readerOf(schema).parse(newer), `${name} at ${path.join(".")}`).toStrictEqual(
            today.data,
          );
        }
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

    expect(
      parsed.envelopes.map((envelope) => ("payload" in envelope ? envelope.payload : envelope)),
    ).toStrictEqual([
      { type: "unknown", named: "order.refunded", order_id: "ord_7c1e05" },
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

  it("refuses an order read back whose address takes a shape it does not know, or that carries a field it does not know, rather than hand it over narrowed", () => {
    // A pickup point read as a bare locality, or a quantity dropped, would be
    // delivered wrongly without a word; a refused answer is a loud stop.
    expect(readerOf(OrderWithStatusSchema).safeParse({ ...read, ship_to: pickup }).success).toBe(
      false,
    );
    expect(readerOf(OrderWithStatusSchema).safeParse({ ...read, quantity: 3 }).success).toBe(false);
  });

  it("marks an order on the stream that carries a field or an address shape it does not know as unread, with the fields named, and reads the rest of the answer", () => {
    // The order is not handed over narrowed, and the price question and the
    // event that came with it are not lost with it.
    const unread = readerOf(WorkerPollResponseSchema).parse({
      ...poll,
      envelopes: [
        { kind: "order", id: "msg_0", sent_at: AT, payload: { ...order, quantity: 3 } },
        { kind: "order", id: "msg_9", sent_at: AT, payload: { ...parcel, ship_to: pickup } },
        ...poll.envelopes,
      ],
    });

    expect(unread.envelopes).toHaveLength(5);
    expect(unread.envelopes[0]).toMatchObject({
      kind: "unknown",
      named: "order",
      subject: order.id,
      issues: [{ code: "unrecognized_keys", keys: ["quantity"], path: ["payload"] }],
    });
    expect(unread.envelopes[1]).toMatchObject({ kind: "unknown", named: "order" });
    expect(unread.envelopes.slice(2)).toStrictEqual(poll.envelopes);
  });

  it("marks a message of a kind it does not know as unread, naming the kind", () => {
    const unread = firstEnvelopeOf({
      ...poll,
      envelopes: [{ kind: "refund_request", id: "msg_0", sent_at: AT, payload: {} }],
    });

    expect(unread).toMatchObject({ kind: "unknown", named: "refund_request" });
  });

  it("reads the contract version of an answer whose envelopes it cannot read, so the version decides first", () => {
    // A gateway of another version may write its messages in a shape this
    // reader cannot read; its answer must still say which version it speaks.
    const other = readerOf(WorkerPollResponseSchema).parse({
      contract_version: "99",
      envelopes: [{ kind: "order", id: "msg_0", sent_at: AT, payload: { ...order, quantity: 3 } }],
    });

    expect(other.contract_version).toBe("99");
  });

  it.each([
    ["no messages at all", { contract_version: "99", error: "no worker here" }],
    ["messages that are not a list", { contract_version: "99", envelopes: "none" }],
    ["a version that is not a word", { contract_version: " ", envelopes: [] }],
  ])(
    "refuses a poll answer with %s, so a page that only names a version is no answer",
    (_what, answer) => {
      expect(readerOf(WorkerPollResponseSchema).safeParse(answer).success).toBe(false);
    },
  );

  it("reads a price question for a purpose it does not know as unknown", () => {
    const asked = {
      ...poll,
      envelopes: [
        {
          ...poll.envelopes[1],
          payload: { ...(poll.envelopes[1]?.payload as object), purpose: "reservation" },
        },
      ],
    };

    expect(firstEnvelopeOf(asked)).toMatchObject({ payload: { purpose: "unknown" } });
  });

  it("never reads a full address that does not fit as the bare locality, dropping who receives the parcel", () => {
    // Of the three shapes an address takes, the locality's fields are a part of
    // the full address's. Ignoring unknown fields must not let an address that
    // fails the full shape pass as the locality with the name and phone gone.
    const { phone_number: _phone, ...phoneless } = parcel.ship_to;
    const answer = { ...read, ship_to: phoneless };

    expect(readerOf(OrderWithStatusSchema).safeParse(answer).success).toBe(false);
    expect(
      readerOf(OrderWithStatusSchema).parse({
        ...read,
        ship_to: { city: "Tabanan", country: "ID" },
      }).ship_to,
    ).toStrictEqual({ city: "Tabanan", country: "ID" });
  });

  it("marks an event of a kind it knows that does not fit as unread, never as an event of a kind added later", () => {
    // Only a kind added later is an unknown event; a known notice that does
    // not fit is a broken message, and it is not passed off as news.
    const newer = (payload: unknown) => ({
      ...poll,
      envelopes: [{ kind: "order_event", id: "msg_0", sent_at: AT, payload }],
    });

    expect(firstEnvelopeOf(newer({ ...unfulfilled, at: "yesterday" }))).toMatchObject({
      kind: "unknown",
      named: "order_event",
      subject: unfulfilled.order_id,
    });
    expect(firstEnvelopeOf(newer({ type: " ", order_id: "ord_1", at: AT }))).toMatchObject({
      kind: "unknown",
      named: "order_event",
    });
  });

  it("still refuses an answer missing a field it needs, or a status that is not a word", () => {
    // The negative control: ignoring what was added is not accepting anything.
    const { id: _id, ...nameless } = read;
    expect(readerOf(OrderWithStatusSchema).safeParse(nameless).success).toBe(false);
    const { status: _status, ...wordless } = read;
    expect(readerOf(OrderWithStatusSchema).safeParse(wordless).success).toBe(false);
    expect(readerOf(OrderWithStatusSchema).safeParse({ ...read, status: 7 }).success).toBe(false);
    expect(readerOf(OrderWithStatusSchema).safeParse({ ...read, status: " " }).success).toBe(false);
    expect(
      readerOf(WorkerPollResponseSchema).safeParse({ ...poll, contract_version: "" }).success,
    ).toBe(false);
  });
});
