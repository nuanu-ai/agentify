/**
 * What a purchase meets at the door, before any price is asked and before
 * anything is charged: how many of one seller's purchases may wait for payment
 * at once, and whether a purchase that charges before its goods is taken from a
 * seller whose own process has gone quiet.
 *
 * Each test puts its card in the store directly, so that a test is about the
 * purchase and not the publishing door.
 */

import { readFileSync } from "node:fs";
import { type Card, CardSchema, type QuoteResponse } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { Integration } from "../ports/store.js";
import {
  type Harness,
  harness,
  paymentNamingNoPayer,
  type Served,
  serve,
  workOnce,
  workUntilStopped,
} from "../testing/harness.js";

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
): Promise<string> => {
  await harnessed.store.switchIntegration(merchantId, through);
  const stored = await harnessed.store.publishCard(
    merchantId,
    pricedCard,
    harnessed.now(),
    through,
  );
  return stored.id;
};

/** Twenty purchases priced and left unpaid, the seller answering each price. */
const twentyWaiting = async (
  harnessed: Harness,
  served: Served,
  itemId: string,
  merchantId: string,
  through: Integration,
) => {
  const worker = workUntilStopped(harnessed, { onQuote: () => priced, merchantId, through });
  try {
    for (let one = 0; one < 20; one += 1) {
      const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
      });
      expect(answered.status).toBe(402);
    }
  } finally {
    await worker.stop();
  }
};

describe("purchases waiting for payment", () => {
  it.each<Integration>(["api", "woocommerce"])(
    "refuse the twenty-first, through %s, before the seller or their shop is asked its price",
    async (through) => {
      const { harnessed, served } = await started();
      const merchantId = harnessed.merchant.id;
      const itemId = await sellingThrough(harnessed, merchantId, through);
      await twentyWaiting(harnessed, served, itemId, merchantId, through);

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
      expect(await harnessed.store.orders(merchantId)).toHaveLength(20);
    },
  );

  it("let a purchase through again once one of the twenty has lapsed unpaid", async () => {
    const { harnessed, served } = await started();
    const merchantId = harnessed.merchant.id;
    const itemId = await sellingThrough(harnessed, merchantId, "api");
    await twentyWaiting(harnessed, served, itemId, merchantId, "api");
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

  it("are counted for each seller apart, so one seller's twenty hold up nobody else", async () => {
    const { harnessed, served } = await started();
    const busy = harnessed.merchant.id;
    const busyItem = await sellingThrough(harnessed, busy, "api");
    await twentyWaiting(harnessed, served, busyItem, busy, "api");
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

describe("a seller's standing", () => {
  it("says since when prepaid purchases are refused for silence, only while they are", async () => {
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

  it("says nothing of silence to a seller with no card that charges before its goods", async () => {
    const { harnessed } = await started();
    await selling(harnessed, syncCard);

    harnessed.advance(11 * MINUTE);

    expect((await harnessed.gateway.standingOf(harnessed.merchant.id)).outOfTouch).toBeNull();
  });
});

describe("a synchronous purchase", () => {
  it("is priced for a seller who has not polled for ten minutes, since nothing is charged before their answer", async () => {
    const { harnessed, served } = await started();
    const itemId = await selling(harnessed, syncCard);

    harnessed.advance(11 * MINUTE);
    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(answered.status).toBe(402);
  });
});

describe("the one table of failures", () => {
  // Its two rows about the door are the scenarios above: a purchase refused
  // before any order exists, which the order machine's own reading of the
  // table never sees.
  const page = readFileSync(new URL("../../../docs/failures.md", import.meta.url), "utf8");
  const rows = [...page.matchAll(/^\| ([^|]+?) \|/gm)].map((row) => row[1]);

  it.each([
    "Twenty of your purchases already wait for payment",
    "No process of yours has polled for ten minutes",
  ])("names the door's refusal “%s” among every failure", (row) => {
    expect(rows).toContain(row);
  });
});
