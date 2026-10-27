/**
 * A card for a parcel at the gateway: who may publish one, and that it sells
 * on every channel alike.
 */

import { type Card, CardSchema, type ShipTo } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  testConfig,
} from "../testing/harness.js";
import { policyFor } from "./runtime.js";

const parcelCard: Card = CardSchema.parse({
  merchant_item_id: "beans-1kg",
  title: "Coffee beans, one kilogram",
  description: "Roasted in Bali this week and sent by courier.",
  price: { amount: "18.00", currency: "USD" },
  fulfillment: "ship",
  ship_within_seconds: 172_800,
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

let open: Harness | null = null;
let served: Served | null = null;

afterEach(async () => {
  await served?.close();
  await open?.stop();
  served = null;
  open = null;
});

/** The live channel, as the gateway derives it from the chain it is paid on. */
const LIVE = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "secret",
};

const withSite = async (harnessed: Harness) => {
  await harnessed.store.setSellerSite(
    harnessed.merchant.id,
    "https://roastery.example",
    harnessed.now(),
  );
};

describe("a card for a parcel", () => {
  it("is published on the test channel by a merchant who gave their shop's site", async () => {
    open = await harness();
    await withSite(open);

    const published = await open.gateway.publishCard(open.merchant.id, parcelCard);

    expect(published.ok).toBe(true);
  });

  it("is refused without the shop's site, as a finding about the merchant", async () => {
    // A parcel that does not arrive is a question its buyer takes to the
    // seller, and the site is the one place this system can send them.
    open = await harness();

    const published = await open.gateway.publishCard(open.merchant.id, parcelCard);

    if (published.ok) throw new Error("a parcel's card was published without a site");
    expect(published.error.problems).toContainEqual(
      expect.objectContaining({ path: [], code: "no_seller_site" }),
    );
  });

  it("names the missing site even when the card is refused for something else", async () => {
    open = await harness();

    const published = await open.gateway.publishCard(open.merchant.id, {
      ...parcelCard,
      price: { amount: "not a number", currency: "USD" },
    });

    if (published.ok) throw new Error("a card with no price was published");
    expect(published.error.problems).toContainEqual(
      expect.objectContaining({ path: [], code: "no_seller_site" }),
    );
  });

  it("asks no site of a merchant publishing anything but a parcel", async () => {
    open = await harness();

    const published = await open.gateway.publishCard(open.merchant.id, {
      merchant_item_id: "room-101",
      title: "A room for the night",
      description: "One night in room 101",
      price: "80.00 USD",
      result: { access_code: "string" },
    });

    expect(published.ok).toBe(true);
  });

  it("is published and sold on the live channel, as on the test channel", async () => {
    open = await harness(LIVE);
    await withSite(open);

    const published = await open.gateway.publishCard(open.merchant.id, parcelCard);
    if (!published.ok) {
      throw new Error(`the live channel refused a parcel's card: ${JSON.stringify(published)}`);
    }
    served = await serve(open);
    const bought = await buyOverHttp(
      open,
      served,
      published.id,
      {
        onQuote: () => ({
          available: true,
          price: { amount: "21.00", currency: "USD" },
          as_of: "2026-08-26T10:15:00Z",
        }),
        onOrder: () => ({ accepted: {} }),
      },
      { priced: { params: {}, ship_to: address }, paid: { params: {}, ship_to: address } },
    );

    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ payment_status: "paid", test: false, shipment: null });
  });

  it("converts the declared shipping window to the order policy duration", () => {
    expect(policyFor(parcelCard, testConfig()).deadlines.asyncFulfillmentMs).toBe(172_800_000);
  });

  it("waits for its charge as long as every order paid before its goods", () => {
    const config = testConfig({ SETTLE_RESPONSE_MS: "2000", SETTLE_BEFORE_GOODS_MS: "15000" });

    expect(policyFor(parcelCard, config).deadlines.settleResponseMs).toBe(15_000);
  });
});
