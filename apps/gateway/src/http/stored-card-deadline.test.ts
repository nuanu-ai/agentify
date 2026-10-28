/**
 * A card's delivery deadline is held to its range at the publish door only.
 * Every answer is checked against its contract on the way out, so a range
 * applied on reading would turn one card stored before it into a failed list
 * for its merchant, and a failed catalog for everybody.
 */

import {
  type Card,
  CatalogPageSchema,
  cardsOf,
  type MerchantCardList,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness, type Served, serve, theMerchantKey } from "../testing/harness.js";

const asMerchant = { authorization: `Bearer ${theMerchantKey("test")}` };

const LISTED: Card = {
  merchant_item_id: "coffee-brunch",
  title: "Coffee and brunch for two",
  description: "A gift card for coffee, pastries or brunch from the seasonal menu.",
  price: { amount: "25.00", currency: "USD" },
  result: { code: { type: "string", title: "The code to show at the counter" } },
  fulfillment: "sync",
};

/** As a test card was stored before the range: delivered within one second. */
const STORED_BEFORE: Card = {
  merchant_item_id: "esim-watch",
  title: "Travel eSIM, one day",
  description: "A data plan for one day, delivered as an activation code.",
  price: { amount: "3.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 1,
};

let open: { harnessed: Harness; served: Served } | null = null;

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

describe("a delivery deadline stored before its range", () => {
  it("is read back to its merchant, listed for agents and priced for a purchase", async () => {
    const harnessed = await harness();
    const served = await serve(harnessed);
    open = { harnessed, served };
    const { merchant, store } = harnessed;
    await store.publishCard(merchant.id, LISTED, harnessed.now());
    const stored = await store.publishCard(merchant.id, STORED_BEFORE, harnessed.now());

    const mine = await served.call("GET", "/v0/cards", { headers: asMerchant });
    const listed = await served.call("GET", "/x402/catalog");
    const priced = await served.call("POST", `/x402/${stored.id}/purchase`, {
      body: { params: {} },
    });

    expect(mine.status).toBe(200);
    expect(
      (mine.body as MerchantCardList).cards.find((one) => one.id === stored.id)?.card,
    ).toStrictEqual(STORED_BEFORE);
    expect(listed.status).toBe(200);
    expect(
      cardsOf(CatalogPageSchema.parse(listed.body))
        .map((card) => card.title)
        .sort(),
    ).toStrictEqual([LISTED.title, STORED_BEFORE.title].sort());
    expect(priced.status).toBe(402);
  });

  it("is refused at the door when it is published again unchanged, and stays as it was stored", async () => {
    const harnessed = await harness();
    const served = await serve(harnessed);
    open = { harnessed, served };
    const stored = await harnessed.store.publishCard(
      harnessed.merchant.id,
      STORED_BEFORE,
      harnessed.now(),
    );

    const republished = await served.call("POST", "/v0/catalog/publish", {
      body: STORED_BEFORE,
      headers: asMerchant,
    });

    expect(republished.status).toBe(422);
    expect(JSON.stringify(republished.body)).toContain("fulfill_deadline_seconds");
    expect((await harnessed.store.cardById(stored.id))?.card).toStrictEqual(STORED_BEFORE);
  });
});
