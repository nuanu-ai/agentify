/**
 * What this gateway writes, held shut at every depth before it is sent.
 *
 * An agent reads the catalog and an order's status open, inside and out
 * (ADR-0006 §5), so its schema cannot refuse a field that should not be there.
 * The outbound check is where one is stopped, and it stops only what its forms
 * shut: an object left open anywhere inside them is a place a merchant's key
 * or a buyer's parameter could ride out to every agent with nothing failing.
 * And a document an agent cannot read is one this gateway must not send in the
 * first place, because the agent would pass it over without a word.
 */

import {
  AgentOrderStatusSchema,
  API_ROUTES,
  type Card,
  CardSchema,
  CatalogPageSchema,
  publicCardOf,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type ZodType, z } from "zod";
import { type Harness, harness, type Served, serve } from "../testing/harness.js";
import { checksBeforeSending } from "./written.js";

type Node = Record<string, unknown>;

/** Every object in a JSON Schema document that names its fields and lets others in. */
function openObjectsIn(node: unknown, at: string, found: string[]): string[] {
  if (Array.isArray(node)) {
    for (const [index, each] of node.entries()) openObjectsIn(each, `${at}[${index}]`, found);
    return found;
  }
  if (typeof node !== "object" || node === null) return found;
  const schema = node as Node;
  if (schema.properties !== undefined && schema.additionalProperties !== false) {
    found.push(at);
  }
  for (const [key, value] of Object.entries(schema)) {
    openObjectsIn(value, `${at}.${key}`, found);
  }
  return found;
}

/**
 * The shape a check takes as input, which is the one that matters here: the
 * document is sent as it was written, not as the check would have parsed it, so
 * an object that quietly drops an unknown field still lets it out.
 */
const asInput = (check: ZodType) => z.toJSONSchema(check, { io: "input" });

/** The path to every object inside a document, the document itself included. */
function objectsIn(node: unknown, path: readonly (string | number)[] = []): (string | number)[][] {
  if (Array.isArray(node)) {
    return node.flatMap((each, index) => objectsIn(each, [...path, index]));
  }
  if (typeof node !== "object" || node === null) return [];
  return [
    [...path],
    ...Object.entries(node).flatMap(([key, value]) => objectsIn(value, [...path, key])),
  ];
}

/**
 * The document with one field nobody was promised added to the object at this
 * path. Its value is an object, so a part whose names are free — a declared
 * field, a delivery — still refuses it by the shape its values have to take.
 */
function leakedAt(document: unknown, path: readonly (string | number)[]): unknown {
  const copy = structuredClone(document) as Node;
  let at: Node = copy;
  for (const key of path) at = at[key] as Node;
  at.merchant_wallet = { address: "0x0000000000000000000000000000000000000001" };
  return copy;
}

/** Every record in a JSON Schema document whose values may be anything at all. */
function freeRecordsIn(node: unknown, at: string, found: string[]): string[] {
  if (Array.isArray(node)) {
    for (const [index, each] of node.entries()) freeRecordsIn(each, `${at}[${index}]`, found);
    return found;
  }
  if (typeof node !== "object" || node === null) return found;
  const schema = node as Node;
  const values = schema.additionalProperties;
  if (values === true || (typeof values === "object" && Object.keys(values ?? {}).length === 0)) {
    found.push(at);
  }
  for (const [key, value] of Object.entries(schema)) {
    freeRecordsIn(value, `${at}.${key}`, found);
  }
  return found;
}

const sendable = (document: ZodType, written: unknown): boolean =>
  checksBeforeSending(document).every((check) => check.safeParse(written).success);

const card: Card = {
  merchant_item_id: "coffee-brunch",
  title: "Coffee and brunch for two",
  description: "A gift card for coffee, pastries or brunch from the seasonal menu.",
  price: { amount: "25.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Where the code goes" } },
  result: { code: { type: "string", title: "The code to show at the counter" } },
  fulfillment: "sync",
};

const shown = publicCardOf(CardSchema.parse(card), {
  id: "itm_4d21bb",
  as_of: "2026-10-07T09:00:00Z",
  seller: { name: "Freeland", site: "https://freeland.example" },
});

const page = { items: [shown] };

const status = {
  order_id: "ord_7c1e05",
  status_url: "https://agentify.ad/x402/orders/ord_7c1e05/status",
  status: "rejected",
  price: {
    amount: "25.00",
    currency: "USD",
    at: "2026-10-07T09:01:00Z",
    as_of: "2026-10-07T09:00:00Z",
  },
  delivered: null,
  test: true,
  refusal: { code: "out_of_stock", message: "none left today" },
  seller: { name: "Freeland", site: "https://freeland.example" },
};

const { refusal: _noRefusal, ...unrefused } = status;

const collected = { ...unrefused, status: "delivered", delivered: { code: "BRUNCH-4F2A" } };

const confirmed = {
  ...shown,
  fulfillment: "confirm",
  confirm_deadline_seconds: 600,
  fulfill_deadline_seconds: 3600,
};

describe("what this gateway checks before it sends a document", () => {
  for (const [name, route] of Object.entries(API_ROUTES)) {
    const document = route.response.document;
    it(`holds ${name} to a form shut at every depth`, () => {
      const shut = checksBeforeSending(document).filter(
        (check) => openObjectsIn(asInput(check), "$", []).length === 0,
      );

      expect(shut.length, `${name} goes out held only to open forms`).toBeGreaterThan(0);
    });
  }

  it("holds an agent's documents to values of a known shape, even where the names are free", () => {
    // A delivery's names are the card's and cannot be listed here, but its
    // values can: a declared field is a string, a number or a boolean, so a
    // record that takes anything would carry a buyer's parameters or a
    // merchant's object out under any name.
    for (const document of [CatalogPageSchema, AgentOrderStatusSchema]) {
      const closed = checksBeforeSending(document).at(-1);
      if (closed === undefined) throw new Error("no check before sending");

      expect(freeRecordsIn(asInput(closed), "$", [])).toStrictEqual([]);
    }
  });

  it("reads the storefront's documents open, so the check above is not the reader's", () => {
    // The negative control: the forms an agent reads have open objects in
    // them, and a walk that found none there would be finding nothing at all.
    expect(openObjectsIn(asInput(AgentOrderStatusSchema), "$", [])).not.toStrictEqual([]);
    expect(openObjectsIn(asInput(CatalogPageSchema), "$", [])).not.toStrictEqual([]);
  });

  it("sends the documents it writes as they stand", () => {
    expect(sendable(CatalogPageSchema, page)).toBe(true);
    expect(sendable(CatalogPageSchema, { items: [confirmed] })).toBe(true);
    expect(sendable(AgentOrderStatusSchema, status)).toBe(true);
    expect(sendable(AgentOrderStatusSchema, collected)).toBe(true);
  });

  it("refuses to send goods on an order whose status says there are none", () => {
    // The goods are the buyer's only once the status says delivered; on any
    // other word there is nothing here to hand over, and something in this
    // field would be whatever a mistake put there.
    for (const word of ["rejected", "in_progress", "refund_due", "delivered_unpaid"]) {
      expect(sendable(AgentOrderStatusSchema, { ...collected, status: word }), word).toBe(false);
    }
  });

  it("refuses to send a field nobody was promised, wherever it is", () => {
    for (const [name, document, written] of [
      ["the catalog", CatalogPageSchema, page],
      ["an order's status", AgentOrderStatusSchema, status],
      ["an order's goods", AgentOrderStatusSchema, collected],
    ] as const) {
      const places = objectsIn(written);
      expect(places.length, name).toBeGreaterThan(3);
      for (const path of places) {
        expect(sendable(document, leakedAt(written, path)), `${name} at ${path.join(".")}`).toBe(
          false,
        );
      }
    }
  });

  it("refuses to send a word this version does not know", () => {
    expect(
      sendable(CatalogPageSchema, { items: [{ ...shown, fulfillment: "by_appointment" }] }),
    ).toBe(false);
    expect(sendable(AgentOrderStatusSchema, { ...status, status: "on_hold" })).toBe(false);
  });

  it("refuses to send a card an agent could not read, or one that claims a wait its mode never has", () => {
    // An agent passes over a card it cannot read without a word, so a card
    // this gateway got wrong would simply vanish from every catalog. Failing
    // here is how it is found instead.
    for (const [why, wrong] of [
      ["a result that promises nothing", { ...shown, result: {} }],
      [
        "a result that might never arrive",
        { ...shown, result: { code: { type: "string", required: false } } },
      ],
      ["a delivery deadline on a synchronous card", { ...shown, fulfill_deadline_seconds: 900 }],
      [
        "a confirmation deadline on an asynchronous card",
        { ...shown, fulfillment: "async", confirm_deadline_seconds: 60 },
      ],
    ] as const) {
      expect(sendable(CatalogPageSchema, { items: [wrong] }), why).toBe(false);
    }
  });
});

describe("the catalog door", () => {
  let open: { harnessed: Harness; served: Served } | null = null;

  afterEach(async () => {
    await open?.served.close();
    await open?.harnessed.stop();
    open = null;
  });

  it("answers that it failed rather than send a card carrying what no agent was promised", async () => {
    // What the server does with the checks above: a projection that let the
    // merchant's own key through is a defect, and the agent is told only that
    // the call did not complete — never the key.
    const harnessed = await harness();
    harnessed.gateway.catalog = async () => ({
      items: [{ ...shown, merchant_item_id: "coffee-brunch" } as typeof shown],
    });
    const served = await serve(harnessed);
    open = { harnessed, served };

    const answered = await served.call("GET", "/x402/catalog");

    expect(answered.status).toBe(500);
    expect(JSON.stringify(answered.body)).not.toContain("coffee-brunch");
  });
});
