/**
 * What a purchase meets at the door, before any price is asked and before
 * anything is charged: how many of one seller's purchases may wait for payment
 * at once, whether anything is taken from a seller whose own process has gone
 * quiet or who has left paid orders unserved, and which cards the catalogue
 * lists while each of these holds.
 *
 * Each test puts its card in the store directly, so that a test is about the
 * purchase and not the publishing door.
 */

import {
  type Card,
  CardSchema,
  CONTRACT_VERSION,
  type QuoteResponse,
  type ShipTo,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Integration } from "../ports/store.js";
import {
  authorisation,
  type Harness,
  harness,
  loggedWhile,
  paymentNamingNoPayer,
  type Served,
  serve,
  signedFor,
  workOnce,
  workUntilStopped,
} from "../testing/harness.js";
import { aWallet } from "../testing/signed-payment.js";
import { PAYMENT_SIGNATURE_HEADER } from "./x402.js";

/** A card whose price its seller is asked at every purchase, as a shop's always is. */
const pricedCard: Card = CardSchema.parse({
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data in Indonesia",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
  price_check: "handler",
});

/** A card charged at the purchase, its goods to follow, at the price it carries. */
const prepaidCard: Card = CardSchema.parse({
  merchant_item_id: "esim-30d",
  title: "A thirty day eSIM",
  description: "Thirty days of data in Indonesia",
  price: { amount: "25.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
});

/** A card whose goods come in the answer and are charged after it. */
const syncCard: Card = CardSchema.parse({
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

/**
 * A parcel a shop is asked the price of, the one kind of shop order the
 * connector takes on rather than delivering itself.
 */
const parcelCard: Card = CardSchema.parse({
  merchant_item_id: "beans-1kg",
  title: "Coffee beans, one kilogram",
  description: "Roasted in Bali this week and sent by courier.",
  price: { amount: "12.00", currency: "USD" },
  fulfillment: "ship",
  ship_within_seconds: 86_400,
  price_check: "handler",
});

/** An address in a real place, with the person and the number taken out of it. */
const address: ShipTo = {
  name: "The buyer",
  line_one: "Jl. Raya Kediri, Beraban",
  city: "Tabanan",
  state: "BA",
  postal_code: "82121",
  country: "ID",
  phone_number: "+62 000 0000 0000",
};

const MINUTE = 60_000;

const priced: QuoteResponse = {
  available: true,
  price: { amount: "12.00", currency: "USD" },
  as_of: "2026-08-26T10:15:00Z",
};

interface Refused {
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

let open: { harnessed: Harness; served: Served } | null = null;

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness(overrides);
  const served = await serve(harnessed);
  open = { harnessed, served };
  return { harnessed, served };
};

/** One of this merchant's cards, published through the integration they sell through. */
const sellingThrough = async (
  harnessed: Harness,
  merchantId: string,
  through: Integration,
  card: Card = pricedCard,
): Promise<string> => {
  await harnessed.store.switchIntegration(merchantId, through);
  const stored = await harnessed.store.publishCard(merchantId, card, harnessed.now(), through);
  return stored.id;
};

/** The identifiers the public catalogue lists, as an agent reads them. */
const listedIn = async (served: Served): Promise<string[]> =>
  ((await served.call("GET", "/x402/catalog")).body as { items: { id: string }[] }).items.map(
    (item) => item.id,
  );

/** Fifty purchases priced and left unpaid, the seller answering each price. */
const fiftyWaiting = async (
  harnessed: Harness,
  served: Served,
  itemId: string,
  merchantId: string,
  through: Integration,
) => {
  const worker = workUntilStopped(harnessed, { onQuote: () => priced, merchantId, through });
  try {
    for (let one = 0; one < 50; one += 1) {
      const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
      });
      expect(answered.status).toBe(402);
      harnessed.advance(100);
    }
  } finally {
    await worker.stop();
  }
};

describe("purchases waiting for payment", () => {
  it.each<Integration>(["api", "woocommerce"])(
    "refuse the fifty-first, through %s, before the seller or their shop is asked its price",
    async (through) => {
      const { harnessed, served } = await started();
      const merchantId = harnessed.merchant.id;
      const itemId = await sellingThrough(harnessed, merchantId, through);
      await fiftyWaiting(harnessed, served, itemId, merchantId, through);

      const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
      });

      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      const { error } = refused.body as Refused;
      expect(error.code).toBe("seller_busy");
      expect(error.retryable).toBe(true);
      expect(error.message).toContain("nothing was charged");
      expect(error.message).toContain("a few seconds");
      // No price question went to the seller's stream, which is the only way a
      // question reaches their code or the connector that asks their shop.
      expect(await harnessed.queue.draw(merchantId, 100, 0)).toStrictEqual([]);
      expect(await harnessed.store.orders(merchantId)).toHaveLength(50);
    },
  );

  it("let a purchase through again once one of the fifty has lapsed unpaid", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    await fiftyWaiting(harnessed, served, itemId, merchantId, "api");
    const [first] = await harnessed.store.orders(merchantId);
    if (first === undefined) throw new Error("no purchase was waiting");

    harnessed.advance(31_000);
    await harnessed.gateway.runner.apply(first.order.id, {
      kind: "deadline_expired",
      at: harnessed.now(),
      deadline: "quote_expiry",
    });
    const worker = workUntilStopped(harnessed, { onQuote: () => priced });
    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });
    await worker.stop();

    expect(answered.status).toBe(402);
  });

  it("hold no place once their prices have run out, while the reminders that close them have not fired", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    await fiftyWaiting(harnessed, served, itemId, merchantId, "api");

    // No reminder is applied: in this harness they wait on real time.
    harnessed.advance(31_000);
    const worker = workUntilStopped(harnessed, { onQuote: () => priced });
    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });
    await worker.stop();

    expect(answered.status).toBe(402);
  });

  it("are said in the log at most once a minute while a seller's purchases are refused for them, naming the seller and how many wait", async () => {
    // A price that holds five minutes, so the fifty still wait a minute on.
    const { harnessed, served } = await started({ QUOTE_TTL_MS: String(5 * MINUTE) });
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    await fiftyWaiting(harnessed, served, itemId, merchantId, "api");
    // Another card of the same seller's, which asks the buyer where to send it.
    const mailed = await harnessed.store.publishCard(
      merchantId,
      { ...pricedCard, merchant_item_id: "esim-mailed", params: { email: { type: "string" } } },
      harnessed.now(),
    );
    const refuse = async () => {
      const refused = await served.call("POST", `/x402/${mailed.id}/purchase`, {
        body: { params: { email: "buyer@example.com" } },
      });
      expect(refused.status).toBe(429);
    };

    const first = await loggedWhile(async () => {
      await refuse();
      harnessed.advance(30_000);
      await refuse();
    });
    harnessed.advance(31_000);
    const later = await loggedWhile(refuse);

    const lines = (said: string) => said.split("\n").filter((line) => line.includes(merchantId));
    expect(lines(first)).toHaveLength(1);
    expect(lines(first)[0]).toContain("50 purchases");
    expect(lines(later)).toHaveLength(1);
    expect(first + later).not.toContain("buyer@example.com");
  });

  it("are told to their seller, only while as many wait as the limit allows", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    await fiftyWaiting(harnessed, served, itemId, merchantId, "api");

    const busy = await harnessed.gateway.standingOf(merchantId);
    harnessed.advance(31_000);
    const free = await harnessed.gateway.standingOf(merchantId);

    expect(busy.busy).toBe(true);
    expect(free.busy).toBe(false);
  });

  it("leave the seller's cards in the catalogue, and a look at one still offers the price", async () => {
    // A place frees within a minute, and anybody can fill the fifty without
    // paying, so a full limit must not empty a seller's listing.
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    await fiftyWaiting(harnessed, served, itemId, merchantId, "api");

    const looked = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(await listedIn(served)).toStrictEqual([itemId]);
    expect(looked.status).toBe(402);
    expect(looked.headers.get("payment-required")).not.toBeNull();
  });

  it("are counted for each seller apart, so one seller's fifty hold up nobody else", async () => {
    const { harnessed, served } = await started();
    const busy = harnessed.merchant.id;
    const busyItem = await sellingThrough(harnessed, busy, "api");
    await fiftyWaiting(harnessed, served, busyItem, busy, "api");
    const other = await harnessed.addMerchant();
    const otherItem = await sellingThrough(harnessed, other.id, "api");

    const worker = workUntilStopped(harnessed, { onQuote: () => priced, merchantId: other.id });
    const answered = await served.call("POST", `/x402/${otherItem}/purchase`, {
      body: { params: {} },
    });
    await worker.stop();

    expect(answered.status).toBe(402);
  });
});

/** The harness's own seller with one card of theirs on sale, through their own code. */
const selling = async (harnessed: Harness, card: Card): Promise<string> =>
  (await harnessed.store.publishCard(harnessed.merchant.id, card, harnessed.now())).id;

describe("a purchase that charges before its goods", () => {
  it("is refused before anything is charged once the seller has not polled for ten minutes, and sells again at their first poll, while a card they paused stays paused", async () => {
    const { harnessed, served } = await started();
    const itemId = await selling(harnessed, prepaidCard);
    const pausedId = await selling(harnessed, { ...prepaidCard, merchant_item_id: "esim-90d" });
    await harnessed.store.setCardPaused(harnessed.merchant.id, pausedId, true);

    harnessed.advance(11 * MINUTE);
    const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(refused.status).toBe(409);
    const { error } = refused.body as Refused;
    expect(error.code).toBe("seller_not_taking_orders");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("nothing was charged");
    expect(error.message).toContain("not taking orders right now");
    expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);

    await workOnce(harnessed, {}, 0);
    const taken = await served.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } });
    const stillPaused = await served.call("POST", `/x402/${pausedId}/purchase`, {
      body: { params: {} },
    });

    expect(taken.status).toBe(402);
    expect(stillPaused.status).toBe(409);
    expect((stillPaused.body as Refused).error.code).toBe("not_selling");
  });

  it("is taken until ten minutes have passed since the seller last polled", async () => {
    const { harnessed, served } = await started();
    const itemId = await selling(harnessed, prepaidCard);

    harnessed.advance(10 * MINUTE);
    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(answered.status).toBe(402);
  });

  it("is taken until ten minutes after the seller's last poll, however seldom each poll is written down", async () => {
    // A poll soon after another is not written again, so what is written can
    // be older than the last poll by up to the write's own window.
    const { harnessed, served } = await started();
    const itemId = await selling(harnessed, prepaidCard);
    harnessed.advance(1_000);
    await workOnce(harnessed, {}, 0);
    harnessed.advance(20_000);
    await workOnce(harnessed, {}, 0);

    harnessed.advance(9 * MINUTE + 50_000);
    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(answered.status).toBe(402);
  });

  it("is not charged at a price named before the seller went quiet and paid after", async () => {
    // A price that holds five minutes, so the payment arrives with its price
    // still standing and only the seller's silence between them.
    const { harnessed } = await started({ QUOTE_TTL_MS: String(5 * MINUTE) });
    const itemId = await selling(harnessed, prepaidCard);
    harnessed.advance(9 * MINUTE);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error(`no price was named: ${offered.step}`);

    harnessed.advance(3 * MINUTE);
    const { payment, fingerprint } = paymentNamingNoPayer(harnessed);
    const paid = await harnessed.gateway.payPurchase(offered.order.order.id, payment, fingerprint);

    expect(paid.step).toBe("seller_not_taking_orders");
    expect(harnessed.facilitator.verifies).toStrictEqual([]);
    expect(harnessed.facilitator.settles).toStrictEqual([]);
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.payment).toBe("none");
  });

  it("is refused while the seller's own code is silent, however often the connector of a shop they left still polls", async () => {
    // The connector inside Agentify draws every connected shop's stream, and
    // draws nothing for a merchant who moved back to their code.
    const { harnessed, served } = await started();
    const itemId = await selling(harnessed, prepaidCard);

    harnessed.advance(11 * MINUTE);
    await workOnce(harnessed, { through: "woocommerce" }, 0);
    const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect((refused.body as Refused).error.code).toBe("seller_not_taking_orders");
  });

  it("is refused for a seller back on their own code whose silent code was preceded only by the shop connector's polls", async () => {
    // While the shop sold, the connector drew its stream; none of that is the
    // seller's code being in touch once the code sells again.
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    await harnessed.gateway.sellThrough(merchantId, "woocommerce");
    harnessed.advance(11 * MINUTE);
    await workOnce(harnessed, { through: "woocommerce" }, 0);
    await harnessed.gateway.sellThrough(merchantId, "api");
    const itemId = await selling(harnessed, prepaidCard);

    const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect((refused.body as Refused).error.code).toBe("seller_not_taking_orders");
  });

  it("is taken from a seller selling through their WooCommerce shop however long since anything polled", async () => {
    // The connector that fills a shop's orders runs inside Agentify, so the
    // shop is in touch whenever Agentify is.
    const { harnessed, served } = await started();
    const itemId = await sellingThrough(harnessed, harnessed.merchant.id, "woocommerce");

    harnessed.advance(60 * MINUTE);
    const worker = workUntilStopped(harnessed, { onQuote: () => priced, through: "woocommerce" });
    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });
    await worker.stop();

    expect(answered.status).toBe(402);
  });
});

describe("a worker's contract admission", () => {
  it.each([syncCard, prepaidCard])(
    "keeps a $fulfillment product off sale through repeated incompatible polls",
    async (card) => {
      const { harnessed, served } = await started();
      const itemId = await selling(harnessed, card);
      const lastCompatible = harnessed.now();
      harnessed.advance(11 * MINUTE);

      for (const version of ["3", "4", "999"]) {
        const poll = await served.call("POST", "/v0/worker/poll", {
          headers: { authorization: `Bearer ${harnessed.merchant.key}` },
          body: { contract_version: version, wait_seconds: 0 },
        });
        expect(poll.status).toBe(200);
        expect(poll.body).toStrictEqual({ contract_version: CONTRACT_VERSION, envelopes: [] });
        harnessed.advance(31_000);
      }

      expect(await harnessed.store.lastContact(harnessed.merchant.id)).toBe(lastCompatible);
      expect(await listedIn(served)).not.toContain(itemId);
      const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
      });
      expect(refused.status).toBe(409);
      expect((refused.body as Refused).error.code).toBe("seller_not_taking_orders");
      expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);
      expect(harnessed.facilitator.verifies).toStrictEqual([]);
      expect(harnessed.facilitator.settles).toStrictEqual([]);
    },
  );

  it("refuses a poll that does not name its contract with words naming the missing field", async () => {
    const { harnessed, served } = await started();
    const lastCompatible = harnessed.now();
    harnessed.advance(11 * MINUTE);
    const poll = await served.call("POST", "/v0/worker/poll", {
      headers: { authorization: `Bearer ${harnessed.merchant.key}` },
      body: { wait_seconds: 0 },
    });
    expect(poll.status).toBe(400);
    expect((poll.body as Refused).error.message).toContain("contract_version");
    expect(await harnessed.store.lastContact(harnessed.merchant.id)).toBe(lastCompatible);
  });

  it("keeps an accepted paid order for a compatible worker and delivers it without a second charge", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await selling(harnessed, prepaidCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error(`no price was named: ${offered.step}`);
    const orderId = offered.order.order.id;
    const { payment, fingerprint } = paymentNamingNoPayer(harnessed);
    const paid = await harnessed.gateway.payPurchase(orderId, payment, fingerprint);
    expect(paid.step).toBe("under_way");
    await vi.waitFor(async () =>
      expect((await harnessed.store.orderById(orderId))?.order.state).toBe("paid"),
    );
    harnessed.advance(11 * MINUTE);
    const poll = (version: string) =>
      served.call("POST", "/v0/worker/poll", {
        headers: { authorization: `Bearer ${harnessed.merchant.key}` },
        body: { contract_version: version, wait_seconds: 0 },
      });

    expect((await poll("3")).body).toStrictEqual({
      contract_version: CONTRACT_VERSION,
      envelopes: [],
    });
    const resumed = await poll(CONTRACT_VERSION);
    const { envelopes } = resumed.body as {
      envelopes: { kind: string; payload: { id: string } }[];
    };
    expect(
      envelopes.some((envelope) => envelope.kind === "order" && envelope.payload.id === orderId),
    ).toBe(true);
    expect(await listedIn(served)).toContain(itemId);
    const goods = { activation_code: "the-original-esim" };
    expect(await harnessed.gateway.deliverOrder(merchantId, orderId, goods)).toMatchObject({
      ok: true,
    });
    expect((await harnessed.store.orderById(orderId))?.delivery).toStrictEqual(goods);
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });

  it("does not shut a compatible worker's sales when another worker names a different contract", async () => {
    const { harnessed, served } = await started();
    const itemId = await selling(harnessed, prepaidCard);
    const headers = { authorization: `Bearer ${harnessed.merchant.key}` };
    harnessed.advance(11 * MINUTE);
    const connected = await served.call("POST", "/v0/worker/poll", {
      headers,
      body: { contract_version: CONTRACT_VERSION, wait_seconds: 0 },
    });
    expect(connected.status).toBe(200);
    await served.call("POST", "/v0/worker/poll", {
      headers,
      body: { contract_version: "3", wait_seconds: 0 },
    });
    expect(await listedIn(served)).toContain(itemId);
    expect(
      (await served.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } })).status,
    ).toBe(402);
  });
});

describe("a seller's standing", () => {
  it("says since when purchases are refused for silence, only while they are", async () => {
    const { harnessed } = await started();
    const merchantId = harnessed.merchant.id;
    const seeded = harnessed.now();
    await selling(harnessed, prepaidCard);

    const inTouch = await harnessed.gateway.standingOf(merchantId);
    harnessed.advance(11 * MINUTE);
    const silent = await harnessed.gateway.standingOf(merchantId);
    await harnessed.store.setSelling(merchantId, "paused");
    const paused = await harnessed.gateway.standingOf(merchantId);

    expect(inTouch.outOfTouch).toBeNull();
    expect(silent.outOfTouch).toStrictEqual({ since: seeded });
    expect(paused.outOfTouch).toBeNull();
  });

  it("says since when purchases are refused for silence to a seller whose only card is synchronous", async () => {
    const { harnessed } = await started();
    const seeded = harnessed.now();
    await selling(harnessed, syncCard);

    harnessed.advance(11 * MINUTE);

    expect((await harnessed.gateway.standingOf(harnessed.merchant.id)).outOfTouch).toStrictEqual({
      since: seeded,
    });
  });

  it("says nothing of silence to a seller whose every card is paused", async () => {
    const { harnessed } = await started();
    const itemId = await selling(harnessed, syncCard);
    await harnessed.store.setCardPaused(harnessed.merchant.id, itemId, true);

    harnessed.advance(11 * MINUTE);

    expect((await harnessed.gateway.standingOf(harnessed.merchant.id)).outOfTouch).toBeNull();
  });
});

describe("a synchronous purchase", () => {
  it("is refused for a seller who has not polled for ten minutes, though nothing would be charged before their answer, and taken again at their first poll", async () => {
    // Nobody would draw the order, so it could only lapse after the buyer had
    // signed and waited.
    const { harnessed, served } = await started();
    const itemId = await selling(harnessed, syncCard);

    harnessed.advance(11 * MINUTE);
    const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });
    await workOnce(harnessed, {}, 0);
    const taken = await served.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } });

    expect(refused.status).toBe(409);
    const { error } = refused.body as Refused;
    expect(error.code).toBe("seller_not_taking_orders");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("nothing was charged");
    expect(await harnessed.store.orders(harnessed.merchant.id)).toHaveLength(1);
    expect(taken.status).toBe(402);
  });

  it("is not taken at a price named before the seller went quiet and paid after", async () => {
    // A price that holds five minutes, so the payment arrives with its price
    // still standing and only the seller's silence between them.
    const { harnessed } = await started({ QUOTE_TTL_MS: String(5 * MINUTE) });
    const itemId = await selling(harnessed, syncCard);
    harnessed.advance(9 * MINUTE);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error(`no price was named: ${offered.step}`);

    harnessed.advance(3 * MINUTE);
    const { payment, fingerprint } = paymentNamingNoPayer(harnessed);
    const paid = await harnessed.gateway.payPurchase(offered.order.order.id, payment, fingerprint);

    expect(paid.step).toBe("seller_not_taking_orders");
    expect(harnessed.facilitator.verifies).toStrictEqual([]);
    expect(await harnessed.queue.draw(harnessed.merchant.id, 100, 0)).toStrictEqual([]);
  });
});

/**
 * `count` purchases of `itemId` paid for and then refused by their seller, so
 * each is an order whose buyer paid and got nothing. The worker answers the
 * price questions and draws the orders, which hands them over, and leaves them
 * to the seller's own calls. A shop's parcel is taken on before it is refused,
 * as the connector takes on a parcel it has ordered in the shop, unless
 * `takenOn` says it never was.
 */
const leftUnserved = async (
  harnessed: Harness,
  itemId: string,
  count: number,
  merchantId: string = harnessed.merchant.id,
  through: Integration = "api",
  takenOn: boolean = through === "woocommerce",
): Promise<string[]> => {
  const shipTo = (await isParcel(harnessed, itemId)) ? address : undefined;
  const worker = workUntilStopped(harnessed, { onQuote: () => priced, merchantId, through });
  const ids: string[] = [];
  try {
    for (let one = 0; one < count; one += 1) {
      const offered = await harnessed.gateway.beginPurchase(itemId, {}, shipTo);
      if (offered.step !== "pay") throw new Error(`no price was named: ${offered.step}`);
      const orderId = offered.order.order.id;
      const { payment, fingerprint } = paymentNamingNoPayer(harnessed);
      await harnessed.gateway.payPurchase(orderId, payment, fingerprint, shipTo);
      await vi.waitFor(async () =>
        expect((await harnessed.store.orderById(orderId))?.order.state).toBe("dispatched"),
      );
      if (takenOn) {
        await harnessed.gateway.acceptOrder(merchantId, orderId, {});
      }
      await harnessed.gateway.refuseOrder(merchantId, orderId, {
        code: "out_of_stock",
        message: "the supplier has none",
      });
      ids.push(orderId);
    }
  } finally {
    await worker.stop();
  }
  for (const id of ids) {
    expect((await harnessed.store.orderById(id))?.order.state).toBe("unfulfilled");
  }
  return ids;
};

/** Whether `itemId` is a parcel's card, whose purchase carries where it goes. */
const isParcel = async (harnessed: Harness, itemId: string): Promise<boolean> =>
  (await harnessed.store.cardById(itemId))?.card.fulfillment === "ship";

/** A buyer's wallet, for payments that have to come from one payer. */
const BUYER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/**
 * One order of a card charged before its goods with a one-second deadline,
 * whose charge nobody could confirm and which settled only after its deadline,
 * so the order became unfulfilled without ever being handed over.
 */
const lateSettled = async (harnessed: Harness): Promise<string> => {
  const published = await harnessed.gateway.publishCard(harnessed.merchant.id, {
    ...prepaidCard,
    merchant_item_id: "esim-late",
    fulfill_deadline_seconds: 1,
  });
  if (!published.ok) throw new Error("the card was refused");
  const merchant = await harnessed.store.merchantById(harnessed.merchant.id);
  const payTo = merchant?.payoutWallet.split?.address;
  if (payTo === undefined) throw new Error("the merchant has no split");
  const payer = BUYER.toLowerCase();
  harnessed.facilitator.willVerify({
    verified: true,
    payer,
    validUntil: null,
    recovery: {
      kind: "evm-exact-eip3009",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payer,
      payTo,
      amount: "25000000",
      validAfter: "0",
      validBefore: String(Math.floor(harnessed.now() / 1000) + 600),
      nonce: `0x${"1".repeat(64)}`,
      notBefore: String(Math.floor(harnessed.now() / 1000) - 30),
    },
  });
  harnessed.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
  const offered = await harnessed.gateway.beginPurchase(published.id, {});
  if (offered.step !== "pay") throw new Error(`no price was named: ${offered.step}`);
  const orderId = offered.order.order.id;
  await harnessed.gateway.payPurchase(orderId, "PAYMENT-LATE", "fp-late");
  const executedAt = harnessed.now();
  harnessed.advance(2_000);
  const attempt = (await harnessed.store.orderById(orderId))?.paymentAttempt;
  if (attempt === undefined) throw new Error("no charge was submitted");
  await harnessed.gateway.runner.completePaymentAttempt(
    orderId,
    attempt.id,
    { settled: true, transaction: `0x${"a".repeat(64)}`, executedAt },
    "chain",
  );
  harnessed.facilitator.willVerify();
  harnessed.facilitator.willSettle();
  return orderId;
};

/** A purchase of `itemId` over HTTP, its price answered by `merchantId`'s worker. */
const tryToBuy = async (
  harnessed: Harness,
  served: Served,
  itemId: string,
  merchantId: string = harnessed.merchant.id,
  through: Integration = "api",
) => {
  const body = (await isParcel(harnessed, itemId))
    ? { params: {}, ship_to: address }
    : { params: {} };
  const worker = workUntilStopped(harnessed, { onQuote: () => priced, merchantId, through });
  try {
    return await served.call("POST", `/x402/${itemId}/purchase`, { body });
  } finally {
    await worker.stop();
  }
};

/** The price questions on a seller's stream, which is how one reaches their code or shop. */
const priceQuestionsFor = async (harnessed: Harness, merchantId: string) =>
  (await harnessed.queue.draw(merchantId, 100, 0)).filter(
    (drawn) => drawn.envelope.kind === "quote_request",
  );

describe("a seller with ten paid orders left unserved", () => {
  it.each<Integration>(["api", "woocommerce"])(
    "is refused every new purchase, through %s, before an order is written or a price asked, and told it is not worth retrying",
    async (through) => {
      const { harnessed, served } = await started();
      const merchantId = harnessed.merchant.id;
      const card = through === "woocommerce" ? parcelCard : pricedCard;
      const itemId = await sellingThrough(harnessed, merchantId, through, card);
      await leftUnserved(harnessed, itemId, 10, merchantId, through);
      const before = (await harnessed.store.orders(merchantId)).length;

      const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
        body: through === "woocommerce" ? { params: {}, ship_to: address } : { params: {} },
      });

      expect(refused.status).toBe(409);
      const { error } = refused.body as Refused;
      expect(error.code).toBe("seller_not_fulfilling");
      expect(error.retryable).toBe(false);
      expect(await harnessed.store.orders(merchantId)).toHaveLength(before);
      expect(await priceQuestionsFor(harnessed, merchantId)).toStrictEqual([]);
    },
  );

  it("is refused a synchronous purchase too, though nothing would be charged before its goods", async () => {
    const { harnessed, served } = await started();
    const itemId = await sellingThrough(harnessed, harnessed.merchant.id, "api");
    const roomId = await selling(harnessed, syncCard);
    await leftUnserved(harnessed, itemId, 10);

    const refused = await served.call("POST", `/x402/${roomId}/purchase`, {
      body: { params: {} },
    });

    expect(refused.status).toBe(409);
    expect((refused.body as Refused).error.code).toBe("seller_not_fulfilling");
  });

  it("still sells with nine", async () => {
    const { harnessed, served } = await started();
    const itemId = await sellingThrough(harnessed, harnessed.merchant.id, "api");
    await leftUnserved(harnessed, itemId, 9);

    expect((await tryToBuy(harnessed, served, itemId)).status).toBe(402);
  });

  it("sells again, with nothing switched back on, once the seller closes fulfillment of one of the ten", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    const [first] = await leftUnserved(harnessed, itemId, 10);
    if (first === undefined) throw new Error("no order was left unserved");
    expect((await tryToBuy(harnessed, served, itemId)).status).toBe(409);

    await harnessed.gateway.closeOrder(merchantId, first, {});

    expect((await tryToBuy(harnessed, served, itemId)).status).toBe(402);
  });

  it("sells again once the seller delivers one of the ten late", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    const [first] = await leftUnserved(harnessed, itemId, 10);
    if (first === undefined) throw new Error("no order was left unserved");
    expect((await tryToBuy(harnessed, served, itemId)).status).toBe(409);

    await harnessed.gateway.deliverOrder(merchantId, first, { activation_code: "LATE-1" });

    expect((await tryToBuy(harnessed, served, itemId)).status).toBe(402);
  });

  it("holds up nobody else's sales", async () => {
    const { harnessed, served } = await started();
    const itemId = await sellingThrough(harnessed, harnessed.merchant.id, "api");
    await leftUnserved(harnessed, itemId, 10);
    const other = await harnessed.addMerchant();
    const otherItem = await sellingThrough(harnessed, other.id, "api");

    expect((await tryToBuy(harnessed, served, otherItem, other.id)).status).toBe(402);
  });

  it("is not charged at a price named before the tenth order was left unserved", async () => {
    const { harnessed } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    const worker = workUntilStopped(harnessed, { onQuote: () => priced });
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    await worker.stop();
    if (offered.step !== "pay") throw new Error(`no price was named: ${offered.step}`);
    await leftUnserved(harnessed, itemId, 10);
    const verified = harnessed.facilitator.verifies.length;
    const settled = harnessed.facilitator.settles.length;

    const { payment, fingerprint } = paymentNamingNoPayer(harnessed);
    const paid = await harnessed.gateway.payPurchase(offered.order.order.id, payment, fingerprint);

    expect(paid.step).toBe("seller_not_fulfilling");
    expect(harnessed.facilitator.verifies).toHaveLength(verified);
    expect(harnessed.facilitator.settles).toHaveLength(settled);
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.payment).toBe("none");
  });

  it("is said in the log at most once a minute, naming the seller and nothing of the buyer", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    await leftUnserved(harnessed, itemId, 10);
    const mailed = await harnessed.store.publishCard(
      merchantId,
      { ...pricedCard, merchant_item_id: "esim-mailed", params: { email: { type: "string" } } },
      harnessed.now(),
    );
    const refuse = async () => {
      const refused = await served.call("POST", `/x402/${mailed.id}/purchase`, {
        body: { params: { email: "buyer@example.com" } },
      });
      expect(refused.status).toBe(409);
    };

    const first = await loggedWhile(async () => {
      await refuse();
      harnessed.advance(30_000);
      await refuse();
    });
    harnessed.advance(31_000);
    const later = await loggedWhile(refuse);

    const lines = (said: string) => said.split("\n").filter((line) => line.includes(merchantId));
    expect(lines(first)).toHaveLength(1);
    expect(lines(later)).toHaveLength(1);
    expect(first + later).not.toContain("buyer@example.com");
  });

  it("is told to the seller, only while ten are left unserved", async () => {
    const { harnessed } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    const [first] = await leftUnserved(harnessed, itemId, 10);
    if (first === undefined) throw new Error("no order was left unserved");

    const stopped = await harnessed.gateway.standingOf(merchantId);
    await harnessed.store.setSelling(merchantId, "paused");
    const paused = await harnessed.gateway.standingOf(merchantId);
    await harnessed.gateway.closeOrder(merchantId, first, {});
    const lifted = await harnessed.gateway.standingOf(merchantId);

    expect(stopped.unserved).toBe(true);
    // A paused seller learns of it before resuming into it.
    expect(paused.unserved).toBe(true);
    expect(lifted.unserved).toBe(false);
  });

  it("is refused at the paid request over HTTP, with nothing charged and nothing worth retrying soon", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    const worker = workUntilStopped(harnessed, { onQuote: () => priced });
    const offered = await served.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } });
    await worker.stop();
    expect(offered.status).toBe(402);
    const [orderId] = (await harnessed.store.orders(merchantId)).map((held) => held.order.id);
    if (orderId === undefined) throw new Error("no order was opened");
    const record = await harnessed.store.orderById(orderId);
    if (record === null) throw new Error("the order went missing");
    await leftUnserved(harnessed, itemId, 10);
    const settled = harnessed.facilitator.settles.length;

    const payTo = (await harnessed.store.merchantById(merchantId))?.payoutWallet.split?.address;
    const { payment } = await signedFor(harnessed, record, aWallet("a buyer"), {
      nonce: "0x7",
      ...(payTo === undefined ? {} : { payTo }),
    });
    const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
    });

    expect(refused.status).toBe(409);
    const { error } = refused.body as Refused;
    expect(error.code).toBe("seller_not_fulfilling");
    expect(error.retryable).toBe(false);
    expect(harnessed.facilitator.settles).toHaveLength(settled);
  });

  it("lets a payment through that releases goods already made and held for their buyer", async () => {
    // The charge for a synchronous purchase failed after its goods were made;
    // paying again releases them, and that order was served.
    const { harnessed } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    const roomId = await selling(harnessed, syncCard);
    harnessed.facilitator.willSettle({ settled: false, reason: "the transfer reverted" });
    const offered = await harnessed.gateway.beginPurchase(roomId, {});
    if (offered.step !== "pay") throw new Error(`no price was named: ${offered.step}`);
    const orderId = offered.order.order.id;
    const first = authorisation(harnessed, BUYER, "0x01");
    const second = authorisation(harnessed, BUYER, "0x02");
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    await harnessed.gateway.payPurchase(orderId, first.payment, first.fingerprint);
    await worker.stop();
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("delivered_unpaid");
    harnessed.facilitator.willSettle();
    await leftUnserved(harnessed, itemId, 10);

    const repeated = await harnessed.gateway.payPurchase(
      orderId,
      second.payment,
      second.fingerprint,
    );

    expect(repeated.step).toBe("settled");
    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("delivered");
  });

  it("answers the buyer of one of the ten who lost their answer and presents their payment again", async () => {
    const { harnessed } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    const [first] = await leftUnserved(harnessed, itemId, 10);
    if (first === undefined) throw new Error("no order was left unserved");
    const kept = (await harnessed.store.orderById(first))?.payment;
    const owner = (await harnessed.store.orderById(first))?.paidBy;
    if (kept == null || owner == null) throw new Error("the order kept no payment");
    const settled = harnessed.facilitator.settles.length;

    const again = await harnessed.gateway.payPurchase(first, kept, owner);

    expect(again.step).not.toBe("seller_not_fulfilling");
    expect("order" in again && again.order.order.id).toBe(first);
    expect(harnessed.facilitator.settles).toHaveLength(settled);
  });

  it("does not count a shop's parcels the connector refused before the shop's own order was made", async () => {
    // The connector runs inside Agentify, so its refusal before creating the
    // shop's order is Agentify's, and the shop never took the order on.
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "woocommerce", parcelCard);
    await leftUnserved(harnessed, itemId, 10, merchantId, "woocommerce", false);

    expect((await tryToBuy(harnessed, served, itemId, merchantId, "woocommerce")).status).toBe(402);
  });

  it("does not count an order that became unfulfilled only when a charge nobody could confirm settled late", async () => {
    // The purchase was closed on the silence before any hand-over, and the
    // charge reported in after its deadline: the seller was never given it.
    const { harnessed, served } = await started({ SETTLE_RESPONSE_MS: "5000" });
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    const late = await lateSettled(harnessed);
    expect((await harnessed.store.orderById(late))?.order.state).toBe("unfulfilled");
    await leftUnserved(harnessed, itemId, 9);

    expect((await tryToBuy(harnessed, served, itemId)).status).toBe(402);
  });
});

describe("a stopped seller's products", () => {
  it("answer an agent's look at them with the refusal and no payment challenge", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    await leftUnserved(harnessed, itemId, 10);

    const looked = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(looked.status).toBe(409);
    expect((looked.body as Refused).error.code).toBe("seller_not_fulfilling");
    expect(looked.headers.get("payment-required")).toBeNull();
  });

  it.each<"closes" | "delivers">(["closes", "delivers"])(
    "leave the catalogue while the stop holds, and come back once the seller %s one of the ten, beside another seller's",
    async (lifting) => {
      const { harnessed, served } = await started();
      const merchantId = harnessed.merchant.id;
      const itemId = await sellingThrough(harnessed, merchantId, "api");
      const other = await harnessed.addMerchant();
      const otherItem = await sellingThrough(harnessed, other.id, "api");
      const [first] = await leftUnserved(harnessed, itemId, 10);
      if (first === undefined) throw new Error("no order was left unserved");

      const stopped = await listedIn(served);
      if (lifting === "closes") {
        await harnessed.gateway.closeOrder(merchantId, first, {});
      } else {
        await harnessed.gateway.deliverOrder(merchantId, first, { activation_code: "LATE-1" });
      }
      const lifted = await listedIn(served);

      expect(stopped).toStrictEqual([otherItem]);
      expect([...lifted].sort()).toStrictEqual([itemId, otherItem].sort());
    },
  );
});

describe("a silent seller's products", () => {
  it("leave the catalogue, whatever their mode, and come back at the seller's first poll, beside another seller's", async () => {
    const { harnessed, served } = await started();
    const prepaid = await selling(harnessed, prepaidCard);
    const room = await selling(harnessed, syncCard);
    harnessed.advance(11 * MINUTE);
    const other = await harnessed.addMerchant();
    const otherItem = await sellingThrough(harnessed, other.id, "api", prepaidCard);

    const silent = await listedIn(served);
    await workOnce(harnessed, {}, 0);
    const back = await listedIn(served);

    expect(silent).toStrictEqual([otherItem]);
    expect([...back].sort()).toStrictEqual([prepaid, room, otherItem].sort());
  });
});

/**
 * One way a card can stand when an agent comes to it: whose card it is, where
 * that is not the harness's own seller, what is done once the card is on sale,
 * what the door answers an unpaid purchase of it with, null where it names a
 * price, and whether that refusal ends by itself within minutes, in which case
 * a look still offers the price so that listings other people run keep it.
 */
interface Standing {
  readonly card: Card;
  readonly through?: Integration;
  readonly seller?: (harnessed: Harness) => Promise<string>;
  readonly after?: (harnessed: Harness, itemId: string) => Promise<void>;
  readonly refused: string | null;
  readonly transient?: true;
}

/**
 * A merchant made the way the dashboard makes one, named and paid, whose own
 * code has never polled.
 */
const neverPolled = async (harnessed: Harness): Promise<string> => {
  const merchantId = await harnessed.gateway.registerMerchant();
  await harnessed.gateway.setSellerName(merchantId, {
    seller_name: "A shop never heard from",
    seller_site: "https://shop.example",
  });
  await harnessed.gateway.setPayoutWallet(merchantId, aWallet("their payout").address, {
    kind: "signed_in",
    email: "owner@example.com",
  });
  return merchantId;
};

const STANDINGS: Readonly<Record<string, Standing>> = {
  "a card charged before its goods, its seller in touch": { card: prepaidCard, refused: null },
  "a synchronous card, its seller in touch": { card: syncCard, refused: null },
  "a card charged before its goods, its seller silent": {
    card: prepaidCard,
    after: async (harnessed) => harnessed.advance(11 * MINUTE),
    refused: "seller_not_taking_orders",
    transient: true,
  },
  "a synchronous card, its seller silent": {
    card: syncCard,
    after: async (harnessed) => harnessed.advance(11 * MINUTE),
    refused: "seller_not_taking_orders",
    transient: true,
  },
  "a card of a seller whose own code has never polled": {
    card: prepaidCard,
    seller: neverPolled,
    refused: "seller_not_taking_orders",
    transient: true,
  },
  "a shop's card, nothing having polled for an hour": {
    card: prepaidCard,
    through: "woocommerce",
    after: async (harnessed) => harnessed.advance(60 * MINUTE),
    refused: null,
  },
  "a card of a seller who paused all selling": {
    card: prepaidCard,
    after: async (harnessed) => {
      await harnessed.store.setSelling(harnessed.merchant.id, "paused");
    },
    refused: "not_selling",
  },
  "a card of a silent seller who paused all selling": {
    card: syncCard,
    after: async (harnessed) => {
      await harnessed.store.setSelling(harnessed.merchant.id, "paused");
      harnessed.advance(11 * MINUTE);
    },
    refused: "not_selling",
  },
  "a card its seller paused": {
    card: prepaidCard,
    after: async (harnessed, itemId) => {
      await harnessed.store.setCardPaused(harnessed.merchant.id, itemId, true);
    },
    refused: "not_selling",
  },
  "a card published through the integration its seller left": {
    card: prepaidCard,
    after: async (harnessed) => {
      await harnessed.store.switchIntegration(harnessed.merchant.id, "woocommerce");
    },
    refused: "not_selling",
  },
  "a card stored at a price the price rule refuses": {
    // Stored as published before the rule was as strict as it is now.
    card: { ...prepaidCard, price: { amount: "25", currency: "USD" } },
    refused: "not_selling",
  },
  "a card of a seller with ten paid orders left unserved": {
    card: syncCard,
    after: async (harnessed) => {
      const unservedItem = await sellingThrough(harnessed, harnessed.merchant.id, "api");
      await leftUnserved(harnessed, unservedItem, 10);
    },
    refused: "seller_not_fulfilling",
  },
};

describe("the catalogue and the door", () => {
  it.each(Object.entries(STANDINGS))(
    "agree on %s: the card is listed, and reads open to its own merchant, exactly when a purchase is offered a price, and a look is refused only for what does not end by itself",
    async (_, { card, through = "api", seller, after, refused, transient }) => {
      const { harnessed, served } = await started();
      const merchantId = seller === undefined ? harnessed.merchant.id : await seller(harnessed);
      const itemId = await sellingThrough(harnessed, merchantId, through, card);
      await after?.(harnessed, itemId);

      const listed = (await listedIn(served)).includes(itemId);
      const looked = await served.call("GET", `/x402/${itemId}/purchase`);
      const bought = await served.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
      });
      const own = (await harnessed.gateway.merchantCards(merchantId)).cards.find(
        (entry) => entry.id === itemId,
      )?.selling;
      const answer = (call: typeof looked) =>
        call.status === 402 ? null : (call.body as Refused).error.code;

      expect({ listed, own, looked: answer(looked), bought: answer(bought) }).toStrictEqual({
        listed: refused === null,
        own: refused === null ? "open" : "paused",
        looked: transient ? null : refused,
        bought: refused,
      });
    },
  );
});
