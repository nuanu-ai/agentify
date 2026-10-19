/**
 * The agent's own route: where a buyer comes back for an order whose goods come
 * later. Knowing the order's identifier is the proof, so the call takes no key
 * and answers about that order and no other.
 *
 * Each of these breaks quietly. A key check attached to an address prefix,
 * rather than read off the route's own `auth`, shuts the agent out. Reading an
 * order whoever sold it must not become a way of learning who the merchants
 * are. And an answer built from the merchant's view of the order would hand a
 * stranger the merchant's key for the product and the buyer's own parameters.
 */

import { request as httpRequest } from "node:http";
import {
  type AgentOrderStatus,
  API_ROUTES,
  type Card,
  type Delivery,
  expandPath,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buyOverHttp,
  type Harness,
  harness,
  type SeededMerchant,
  type Served,
  serve,
  theMerchantKey,
} from "../testing/harness.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";

/** A card whose goods come later: the money moves at the purchase, the eSIM does not. */
const laterCard: Card = {
  merchant_item_id: "esim-30d",
  title: "An eSIM for thirty days",
  description: "Thirty days of data, delivered to the address given at purchase",
  price: { amount: "80.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

/** A card delivered on the call itself, which is what makes an unpaid delivery possible. */
const nowCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO, ...overrides });
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const keyOf = (merchant: SeededMerchant): Record<string, string> => ({
  authorization: `Bearer ${merchant.key}`,
});

const publish = async (
  served: Served,
  card: Card,
  headers: Record<string, string> = { authorization: `Bearer ${theMerchantKey("test")}` },
): Promise<string> => {
  const answered = await served.call("POST", "/v0/catalog/publish", { body: card, headers });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return (answered.body as { id: string }).id;
};

/** An order of a card whose goods come later, taken on by its merchant and not yet delivered. */
const orderTakenOn = async (
  harnessed: Harness,
  served: Served,
  itemId: string,
  merchantId?: string,
): Promise<string> => {
  const bought = await buyOverHttp(harnessed, served, itemId, {
    ...(merchantId === undefined ? {} : { merchantId }),
    onOrder: () => ({ accepted: {} }),
  });
  expect(bought.status, JSON.stringify(bought.body)).toBe(200);
  // Read off the purchase answer, the way an agent would read it.
  return (bought.body as AgentOrderStatus).order_id;
};

const statusOf = async (served: Served, orderId: string, headers?: Record<string, string>) =>
  served.call("GET", `/x402/orders/${orderId}/status`, headers === undefined ? {} : { headers });

/**
 * The production shape: TLS ends at the proxy in front, and the process behind
 * it is reached over plain http on an address nobody outside sees.
 */
const PUBLIC_BASE = "https://agentify.ad";

/** Where one order is collected, as the route table spells it under that base. */
const collectedAt = (orderId: string): string =>
  `${PUBLIC_BASE}${expandPath(API_ROUTES.get_order_status.path, { order_id: orderId })}`;

/**
 * The gateway under test listens on loopback, not at the public address it
 * names, so a test can call only the path and query of an address it was given.
 */
const onThisGateway = (address: unknown): string => {
  const parsed = new URL(String(address));
  return `${parsed.pathname}${parsed.search}`;
};

/**
 * The same gateway, reached by calls that claim they arrived somewhere else.
 * `fetch` will not send a Host header it did not take from the URL, so these
 * go out through `node:http`; otherwise they behave as `Served.call` does.
 */
const arrivingWith = (served: Served, claimed: Readonly<Record<string, string>>): Served => ({
  ...served,
  call: (method, path, options = {}) =>
    new Promise((resolve, reject) => {
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      const outgoing = httpRequest(
        new URL(path, served.url),
        {
          method,
          headers: {
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...options.headers,
            ...claimed,
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              for (const one of [value ?? []].flat()) headers.append(name, one);
            }
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = text;
            try {
              parsed = text === "" ? null : JSON.parse(text);
            } catch {
              // Left as text, as `Served.call` leaves it.
            }
            resolve({ status: incoming.statusCode ?? 0, headers, body: parsed });
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    }),
});

describe("where an agent that paid comes back to", () => {
  it("names the address in the purchase answer, and the goods are collected there", async () => {
    // The agent holds the purchase answer and nothing else, and guessing an
    // address from the order identifier answers `no_such_route`, so the named
    // address has to be enough on its own.
    const { served, harnessed } = await started({ PUBLIC_BASE_URL: PUBLIC_BASE });
    const itemId = await publish(served, laterCard);

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ accepted: {} }),
    });

    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    const answered = bought.body as Record<string, unknown>;
    const orderId = String(answered.order_id);
    expect(answered.status_url).toBe(collectedAt(orderId));

    const waiting = await served.call("GET", onThisGateway(answered.status_url));
    expect(waiting.status).toBe(200);
    expect(waiting.body).toStrictEqual(bought.body);

    const delivered = await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      body: { activation_code: "LPA:1$example.com$ACTIVATE" },
      headers: keyOf(harnessed.merchant),
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);

    const collected = await served.call("GET", onThisGateway(answered.status_url));
    expect(collected.status).toBe(200);
    expect((collected.body as AgentOrderStatus).status).toBe("delivered");
    expect((collected.body as AgentOrderStatus).delivered).toStrictEqual({
      activation_code: "LPA:1$example.com$ACTIVATE",
    });
  });

  it("names the same address from both doors, for goods handed over on the call", async () => {
    // A synchronous sale, finished by the time the answer is written. The
    // purchase and the status route answer in one document, so both must name
    // the order's address, in one spelling.
    const { served, harnessed } = await started({ PUBLIC_BASE_URL: PUBLIC_BASE });
    const itemId = await publish(served, nowCard);

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });

    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    const orderId = String((bought.body as Record<string, unknown>).order_id);
    expect((bought.body as Record<string, unknown>).status_url).toBe(collectedAt(orderId));

    const later = await statusOf(served, orderId);

    expect(later.status).toBe(200);
    expect((later.body as Record<string, unknown>).status_url).toBe(collectedAt(orderId));
  });

  it("builds the address from its own configuration, whatever a call says about where it arrived", async () => {
    // Behind the TLS-ending proxy the request says http and names whichever
    // host was forwarded to, and the forwarding headers are whatever the caller
    // wrote. An address built from any of them could send a paid order's
    // identifier over plain http or to a host of the caller's choosing.
    const { served, harnessed } = await started({ PUBLIC_BASE_URL: PUBLIC_BASE });
    const itemId = await publish(served, laterCard);
    const elsewhere = arrivingWith(served, {
      host: "elsewhere.example",
      "x-forwarded-proto": "http",
      "x-forwarded-host": "elsewhere.example:8443",
    });

    const bought = await buyOverHttp(harnessed, elsewhere, itemId, {
      onOrder: () => ({ accepted: {} }),
    });

    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    const orderId = String((bought.body as Record<string, unknown>).order_id);
    expect((bought.body as Record<string, unknown>).status_url).toBe(collectedAt(orderId));

    const later = await elsewhere.call(
      "GET",
      expandPath(API_ROUTES.get_order_status.path, { order_id: orderId }),
    );

    expect(later.status).toBe(200);
    expect((later.body as Record<string, unknown>).status_url).toBe(collectedAt(orderId));
  });
});

describe("coming back for goods that were not ready", () => {
  it("tells the buyer where an order stands before the merchant has issued anything", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);

    const answered = await statusOf(served, orderId);

    expect(answered.status).toBe(200);
    const status = answered.body as AgentOrderStatus;
    expect(status.order_id).toBe(orderId);
    // Not an ending: an agent that read this as one would write off a sale
    // still going through.
    expect(status.status).toBe("in_progress");
    expect(status.delivered).toBeNull();
    // The money moved at the purchase, so what it cost is a fact already.
    expect(status.price?.amount).toBe("80.00");
    expect(status.price?.currency).toBe("USD");
  });

  it("hands over the goods once the merchant has issued them", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);

    const delivered = await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      body: { activation_code: "LPA:1$example.com$ACTIVATE" },
      headers: keyOf(harnessed.merchant),
    });
    expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);

    const answered = await statusOf(served, orderId);

    expect(answered.status).toBe(200);
    const status = answered.body as AgentOrderStatus;
    expect(status.status).toBe("delivered");
    expect(status.delivered).toStrictEqual({ activation_code: "LPA:1$example.com$ACTIVATE" });
  });

  it("will not hand over goods the buyer has not paid for", async () => {
    // A synchronous delivery whose charge failed: the goods exist but nothing
    // was paid. Handing them over here would let anyone collect for free what a
    // failed charge left behind.
    const { served, harnessed } = await started();
    harnessed.facilitator.willSettle({ settled: false, reason: "the transfer reverted" });
    const itemId = await publish(served, nowCard);

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const orderId = (bought.body as { order_id: string }).order_id;
    expect(orderId, JSON.stringify(bought.body)).toBeTypeOf("string");

    const answered = await statusOf(served, orderId);

    const status = answered.body as AgentOrderStatus;
    expect(status.status).toBe("delivered_unpaid");
    expect(status.delivered).toBeNull();
    expect(JSON.stringify(answered.body)).not.toContain("SESAME");
  });
});

describe("a refusal the merchant made", () => {
  it("carries the merchant's own code and sentence to the agent, at the purchase and afterwards", async () => {
    // "There is none" and "those parameters do not work" want different next
    // moves from the agent, so the merchant's code and sentence reach it
    // unchanged from both doors.
    const { served, harnessed } = await started();
    const itemId = await publish(served, nowCard);

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ refused: { code: "out_of_stock", message: "the room is taken" } }),
    });

    expect(bought.status).toBe(409);
    const refused = bought.body as AgentOrderStatus;
    expect(refused.status).toBe("rejected");
    expect(refused.refusal).toStrictEqual({
      code: "out_of_stock",
      message: "the room is taken",
    });

    const later = await statusOf(served, refused.order_id);

    expect(later.status).toBe(200);
    expect((later.body as AgentOrderStatus).refusal).toStrictEqual(refused.refusal);
    // The agent's schema accepts unknown fields, so it cannot catch one that
    // leaked (a buyer's parameter, the merchant's key for the product); this
    // list is where one would be caught.
    for (const answered of [bought.body, later.body]) {
      expect(Object.keys(answered as object).sort()).toStrictEqual([
        "delivered",
        "order_id",
        "price",
        "refusal",
        "seller",
        "status",
        "status_url",
        "test",
      ]);
    }
  });

  it("says nothing about a refusal on an ending nobody refused", async () => {
    // An absent `refusal` must mean "no merchant refused this order", not "we
    // did not say", so filling it from whatever closed the order fails here.
    const { served, harnessed } = await started({
      QUOTE_RESPONSE_MS: "20",
      SYNC_RESPONSE_MS: "80",
      SETTLE_RESPONSE_MS: "40",
      SYNC_BUDGET_MS: "2000",
    });
    const laterItem = await publish(served, laterCard);
    const nowItem = await publish(served, nowCard);

    const orderId = await orderTakenOn(harnessed, served, laterItem);
    await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      body: { activation_code: "LPA:1$example.com$ACTIVATE" },
      headers: keyOf(harnessed.merchant),
    });
    // A synchronous purchase whose handler never answers: the order closes on
    // its own deadline, and nobody said a word about why.
    const timedOut = await buyOverHttp(harnessed, served, nowItem, {});

    const delivered = (await statusOf(served, orderId)).body as AgentOrderStatus;
    const expired = (await statusOf(served, (timedOut.body as AgentOrderStatus).order_id))
      .body as AgentOrderStatus;

    expect(delivered.status).toBe("delivered");
    expect(delivered.refusal).toBeUndefined();
    expect(expired.status).toBe("expired");
    expect(expired.refusal).toBeUndefined();
  });
});

describe("an order that owes a refund", () => {
  // `refund_due` alone reads as "a refund is on its way". The agent has to be
  // told why the money is owed, in the words the merchant's own event uses,
  // and in a sentence that nothing here will say when it has been paid back.
  const owingOf = async (served: Served, orderId: string): Promise<AgentOrderStatus> => {
    let read: AgentOrderStatus | undefined;
    await vi.waitFor(
      async () => {
        const answered = await statusOf(served, orderId);
        expect(answered.status).toBe(200);
        read = answered.body as AgentOrderStatus;
        expect(read.status).toBe("refund_due");
      },
      { timeout: 2_000, interval: 5 },
    );
    if (read === undefined) throw new Error("the order was never read");
    return read;
  };

  it("says the time for the goods ran out after the money moved", async () => {
    const { served, harnessed } = await started({ DEFAULT_ASYNC_FULFILLMENT_MS: "80" });
    const itemId = await publish(served, {
      ...laterCard,
      fulfill_deadline_seconds: undefined,
    } as Card);
    const orderId = await orderTakenOn(harnessed, served, itemId);

    const owing = await owingOf(served, orderId);

    expect(owing.reason?.code).toBe("deadline_passed");
    expect(owing.reason?.message).toMatch(/\S/);
    expect(owing.refusal).toBeUndefined();
  });

  it("says the merchant refused after the money moved, beside the merchant's own words", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);
    const refused = await served.call("POST", `/v0/orders/${orderId}/refuse`, {
      body: { code: "out_of_stock", message: "the last eSIM went to somebody else" },
      headers: keyOf(harnessed.merchant),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(200);

    const owing = await owingOf(served, orderId);

    expect(owing.reason?.code).toBe("refused");
    expect(owing.reason?.message).toMatch(/\S/);
    expect(owing.refusal).toStrictEqual({
      code: "out_of_stock",
      message: "the last eSIM went to somebody else",
    });
  });

  it("says the merchant left after the money moved", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);
    await harnessed.gateway.runner.apply(orderId, {
      kind: "merchant_departed",
      at: harnessed.now(),
    });

    const owing = await owingOf(served, orderId);

    expect(owing.reason?.code).toBe("merchant_left");
    expect(owing.reason?.message).toMatch(/\S/);
  });

  it("says the charge was reported after the purchase was closed, not that goods came late", async () => {
    // A charge that went silent closes the purchase before the merchant is
    // sent anything. If it later turns out to have gone through, the buyer is
    // owed the price, but no time for any goods ever ran: the sentence for
    // goods that came late would describe a purchase that did not happen.
    const { served, harnessed } = await started({
      SETTLE_BEFORE_GOODS_MS: "50",
      DEFAULT_ASYNC_FULFILLMENT_MS: "80",
    });
    const itemId = await publish(served, {
      ...laterCard,
      fulfill_deadline_seconds: undefined,
    } as Card);
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "the facilitator timed out" });
    const silent = await buyOverHttp(harnessed, served, itemId, {});
    const reported = (silent.body as AgentOrderStatus).order_id;
    // Closed on the silence, as an operator finds it before recording the charge.
    await vi.waitFor(
      async () =>
        expect((await harnessed.store.orderById(reported))?.order.closure?.cause).toBe(
          "payment_outcome_unknown",
        ),
      { timeout: 2_000, interval: 5 },
    );
    expect(((await statusOf(served, reported)).body as AgentOrderStatus).status).toBe(
      "payment_unresolved",
    );
    await harnessed.gateway.runner.apply(reported, {
      kind: "payment_settled",
      at: harnessed.now(),
    });
    harnessed.facilitator.willSettle({ settled: true, transaction: "0xsettled" });
    const late = await orderTakenOn(harnessed, served, itemId);

    const owingLate = await owingOf(served, late);
    const owingReported = await owingOf(served, reported);

    expect(owingReported.reason?.code).toBe("deadline_passed");
    expect(owingReported.reason?.message).toMatch(/\S/);
    expect(owingReported.reason?.message).not.toBe(owingLate.reason?.message);
  });

  it("gives each way of coming to owe a sentence of its own", async () => {
    // One sentence for all three would tell an agent waiting on a late
    // delivery the same thing as one whose seller has gone.
    const { served, harnessed } = await started({ DEFAULT_ASYNC_FULFILLMENT_MS: "80" });
    const lateItem = await publish(served, {
      ...laterCard,
      merchant_item_id: "esim-late",
      fulfill_deadline_seconds: undefined,
    } as Card);
    const keptItem = await publish(served, laterCard);
    const late = await orderTakenOn(harnessed, served, lateItem);
    const refused = await orderTakenOn(harnessed, served, keptItem);
    await served.call("POST", `/v0/orders/${refused}/refuse`, {
      body: { code: "out_of_stock", message: "none left" },
      headers: keyOf(harnessed.merchant),
    });
    const left = await orderTakenOn(harnessed, served, keptItem);
    await harnessed.gateway.runner.apply(left, { kind: "merchant_departed", at: harnessed.now() });

    const sentences = await Promise.all(
      [late, refused, left].map(
        async (orderId) => (await owingOf(served, orderId)).reason?.message,
      ),
    );

    expect(new Set(sentences).size).toBe(3);
  });
});

describe("the door on the agent's route", () => {
  it("answers the same to a key, to somebody else's key, and to no key", async () => {
    // An agent has no key, so the call with none must be answered. Whatever is
    // in the authorization header, even a junk key refused everywhere else in
    // this gateway, this route neither opens nor closes on it.
    const { served, harnessed } = await started();
    const other = await harnessed.addMerchant("Another merchant");
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);

    const withNone = await statusOf(served, orderId);
    const withOwn = await statusOf(served, orderId, keyOf(harnessed.merchant));
    const withStranger = await statusOf(served, orderId, keyOf(other));
    const withJunk = await statusOf(served, orderId, {
      authorization: "Bearer a-key-that-was-never-issued",
    });

    for (const answered of [withOwn, withStranger, withJunk]) {
      expect(answered.status).toBe(withNone.status);
      expect(answered.body).toStrictEqual(withNone.body);
    }
    expect(withNone.status).toBe(200);
  });
});

describe("what the answer carries", () => {
  it("reads an order whichever merchant sold it, and names the seller only as the catalog does", async () => {
    // With no key there is no merchant to scope to, so the route must not
    // reveal which merchants exist or what they call their products. The
    // seller appears only as on its cards: a name and a site.
    const { served, harnessed } = await started();
    const sellerName = "Not the harness's own seller";
    const seller = await harnessed.addMerchant(sellerName);
    const itemId = await publish(served, laterCard, keyOf(seller));
    const orderId = await orderTakenOn(harnessed, served, itemId, seller.id);

    const answered = await statusOf(served, orderId);

    expect(answered.status).toBe(200);
    expect(Object.keys(answered.body as object).sort()).toStrictEqual([
      "delivered",
      "order_id",
      "price",
      "seller",
      "status",
      "status_url",
      "test",
    ]);
    expect((answered.body as { seller: unknown }).seller).toStrictEqual({
      name: "Not the harness's own seller",
      site: null,
    });
    // The name is there in `seller` and nowhere else; which merchant account
    // it is, what they call the product, and which card it came from are all
    // things a stranger holding an identifier learns nothing about.
    const { seller: shown, ...rest } = answered.body as Record<string, unknown>;
    const written = JSON.stringify(rest);
    expect(JSON.stringify(shown)).not.toContain(seller.id);
    expect(written).not.toContain(seller.id);
    expect(written).not.toContain(sellerName);
    expect(written).not.toContain("esim-30d");
    expect(written).not.toContain(itemId);
  });
});

describe("what is kept of the answer", () => {
  it("asks every cache to keep nothing, since whoever holds the answer holds the goods", async () => {
    // The identifier is the only key to the order and its goods. A copy kept
    // by a proxy, a browser or an agent's HTTP client would hand them to
    // whoever reads that copy, so no answer of this route may be stored, and
    // the refusal is answered alike so it tells no order apart.
    const { served, harnessed } = await started();
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);
    await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      body: { activation_code: "LPA:1$example.com$ACTIVATE" },
      headers: keyOf(harnessed.merchant),
    });

    const collected = await statusOf(served, orderId);
    const unknown = await statusOf(served, "ord_nothing_here");

    expect((collected.body as AgentOrderStatus).status).toBe("delivered");
    expect(collected.headers.get("cache-control")).toBe("no-store");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
  });
});

describe("an identifier that names nothing", () => {
  it("answers it exactly as it answers any other, saying only that there is no such order", async () => {
    // The route tells nobody apart, so it must not tell identifiers apart
    // either: two guesses come back byte for byte the same, and neither says
    // whether the string was ever an order of anybody's.
    const { served } = await started();

    const first = await statusOf(served, "ord_nothing_here");
    const second = await statusOf(served, "ord_nor_here");

    expect(first.status).toBe(404);
    expect(first.body).toStrictEqual({
      error: { code: "no_such_order", message: "there is no such order", retryable: false },
    });
    expect(second.body).toStrictEqual(first.body);
  });

  it("has one refusal and not two, so an unknown identifier is never told from a forbidden one", async () => {
    // The route cannot hide that a real identifier names an order: the
    // identifier is the proof, so a real one is answered, and only its being
    // long and random keeps walking them from finding anything. What it does
    // hide is a second refusal: nothing here is scoped to a caller, so there is
    // no "exists and is not yours", only one refusal for whatever does not
    // resolve.
    const { served, harnessed } = await started();
    const itemId = await publish(served, laterCard);
    const orderId = await orderTakenOn(harnessed, served, itemId);

    const real = await statusOf(served, orderId);
    const invented = await statusOf(served, `${orderId}_no`);
    const nothingLikeOne = await statusOf(served, "not-an-order-at-all");

    expect(real.status).toBe(200);
    // Every identifier that resolves to nothing gets the one refusal, whatever
    // it looks like: a near-miss of a real order and a string that was never
    // shaped like one are not told apart either.
    expect(invented.status).toBe(404);
    expect(nothingLikeOne.body).toStrictEqual(invented.body);
    expect((invented.body as { error: { code: string } }).error.code).toBe("no_such_order");
  });
});

describe("the goods as the merchant wrote them", () => {
  it("hands the delivery back unchanged", async () => {
    // What the merchant handed over is what the buyer collects. A delivery
    // reshaped on the way out is the one thing an agent cannot check against
    // anything, because it holds nothing else about the order.
    const { served, harnessed } = await started({ PUBLIC_BASE_URL: PUBLIC_BASE });
    const itemId = await publish(served, {
      ...laterCard,
      result: {
        activation_code: { type: "string" },
        valid_until: { type: "string" },
      },
    });
    const orderId = await orderTakenOn(harnessed, served, itemId);
    const goods: Delivery = {
      activation_code: "LPA:1$example.com$ACTIVATE",
      valid_until: "2026-09-26",
    };

    await served.call("POST", `/v0/orders/${orderId}/deliver`, {
      body: goods,
      headers: keyOf(harnessed.merchant),
    });

    expect((await statusOf(served, orderId)).body).toStrictEqual({
      order_id: orderId,
      status_url: collectedAt(orderId),
      status: "delivered",
      price: {
        amount: "80.00",
        currency: "USD",
        at: "2026-08-26T12:00:00.000Z",
        as_of: "2026-08-26T12:00:00.000Z",
      },
      delivered: goods,
      // Only this field tells a test order from a real one; every other field
      // reads the same whether the charge was real or not.
      test: true,
      seller: { name: "The merchant", site: null },
    });
  });
});
