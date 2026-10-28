import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { WORKER_ENVELOPE_KINDS, WorkerEnvelopeSchema } from "./envelope.js";
import { toJsonSchemas } from "./index.js";
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

const quoteRequest = {
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price_id: "prc_31a8c0",
  purpose: "purchase",
  expires_at: "2026-08-26T10:20:00Z",
};

const orderEvent = {
  type: "order.unfulfilled",
  order_id: "ord_7c1e05",
  at: "2026-08-27T10:20:00Z",
  price: { amount: "5.00", currency: "USD" },
  reason: "deadline_passed",
};

/** One envelope of each kind, carrying the payload that kind is named for. */
const envelopes = {
  order: { kind: "order", id: "msg_4a19be", sent_at: "2026-08-26T10:20:01Z", payload: order },
  quote_request: {
    kind: "quote_request",
    id: "msg_8b02cd",
    sent_at: "2026-08-26T10:19:58Z",
    payload: quoteRequest,
  },
  order_event: {
    kind: "order_event",
    id: "msg_1f77a0",
    sent_at: "2026-08-27T10:20:00Z",
    payload: orderEvent,
  },
} as const satisfies Record<string, Record<string, unknown>>;

describe("the worker envelope", () => {
  // The promise: a worker reading a message off the one stream can tell which
  // of the three kinds it holds before doing anything with it.

  for (const kind of WORKER_ENVELOPE_KINDS) {
    it(`carries a ${kind} without changing it`, () => {
      expect(WorkerEnvelopeSchema.parse(envelopes[kind])).toStrictEqual(envelopes[kind]);
    });
  }

  it("names three kinds and no more", () => {
    expect([...WORKER_ENVELOPE_KINDS]).toStrictEqual(["order", "quote_request", "order_event"]);
  });

  it("refuses a kind it has never heard of, and says which values it knows", () => {
    // A consumer switching on the kind must read an unknown one as a version
    // mismatch, so a fourth kind fails loudly at the boundary.
    const complaint = errorOf(WorkerEnvelopeSchema, {
      kind: "confirmation_request",
      id: "msg_4a19be",
      sent_at: "2026-08-26T10:20:01Z",
      payload: order,
    });

    expect(complaint).toContain("kind");
    for (const kind of WORKER_ENVELOPE_KINDS) expect(complaint, kind).toContain(kind);
  });

  it("refuses an envelope with no kind at all", () => {
    const { kind, ...withoutKind } = envelopes.order;
    expect(kind).toBeDefined();
    expect(errorOf(WorkerEnvelopeSchema, withoutKind)).toContain("kind");
  });

  // Asked of one kind only: `envelopeOf` builds every branch from one
  // declaration. If a branch is ever written out by hand, this has to loop
  // over the kinds again.
  for (const field of ["id", "sent_at", "payload"]) {
    it(`refuses an envelope without ${field} and names it`, () => {
      expectMissingFieldRejected(WorkerEnvelopeSchema, envelopes.order, field);
    });
  }

  it("holds the payload to the schema its kind names, and refuses another kind's", () => {
    // An order envelope carrying a price question would reach an order
    // handler; without this the marker is a label nobody checks.
    expect(
      WorkerEnvelopeSchema.safeParse({ ...envelopes.order, payload: quoteRequest }).success,
    ).toBe(false);
    expect(
      WorkerEnvelopeSchema.safeParse({ ...envelopes.quote_request, payload: order }).success,
    ).toBe(false);
    expect(
      WorkerEnvelopeSchema.safeParse({ ...envelopes.order_event, payload: order }).success,
    ).toBe(false);
  });

  it("refuses a field it does not know", () => {
    // A field a worker might act on that the contract never defined is a
    // promise nobody made.
    expect(errorOf(WorkerEnvelopeSchema, { ...envelopes.order, attempt: 2 })).toContain("attempt");
  });

  it("refuses a send time with no zone, which is an hour of the day and not a moment", () => {
    expect(
      WorkerEnvelopeSchema.safeParse({ ...envelopes.order, sent_at: "2026-08-26T10:20:01" })
        .success,
    ).toBe(false);
  });

  it("refuses a blank message identifier", () => {
    expect(WorkerEnvelopeSchema.safeParse({ ...envelopes.order, id: "" }).success).toBe(false);
    expect(WorkerEnvelopeSchema.safeParse({ ...envelopes.order, id: " msg_4a19be" }).success).toBe(
      false,
    );
  });
});

describe("the kinds and the registry", () => {
  it("validates each named exported payload document and rejects a different kind", () => {
    const documents = toJsonSchemas();
    const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
    for (const [kind, payload, wrong] of [
      ["order", order, quoteRequest],
      ["quote_request", quoteRequest, order],
      ["order_event", orderEvent, order],
    ] as const) {
      const validate = ajv.compile(documents[kind]);
      expect(validate(payload), `${kind}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(validate(wrong), kind).toBe(false);
    }
  });
});
