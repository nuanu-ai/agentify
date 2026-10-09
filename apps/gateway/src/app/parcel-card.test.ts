/**
 * A card for a parcel at the gateway (ADR-0033): who may publish one, and on
 * which channel.
 *
 * A parcel's merchant gives the site of their shop, because a parcel that does
 * not arrive is a question its buyer takes there. And a parcel sells on the
 * test channel only: on the live one the refund of a lost parcel, the
 * merchant's view of whom to pay back and the rule about who may read a
 * tracking number are not running yet, so the card is refused there, in words
 * that say why. What the gateway does with a published one is what the rest of
 * the mode is built on: the order is held to the card's time to ship.
 */

import {
  type Card,
  CardSchema,
  CatalogPageSchema,
  publicCardOf,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness, testConfig } from "../testing/harness.js";
import { policyFor } from "./runtime.js";
import { checksBeforeSending } from "./written.js";

const parcelCard: Card = CardSchema.parse({
  merchant_item_id: "beans-1kg",
  title: "Coffee beans, one kilogram",
  description: "Roasted in Bali this week and sent by courier.",
  price: { amount: "18.00", currency: "USD" },
  fulfillment: "ship",
  ship_within_seconds: 172_800,
  price_check: "handler",
});

let open: Harness | null = null;

afterEach(async () => {
  await open?.stop();
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

  it("is refused on the live channel, as a finding on its mode", async () => {
    open = await harness(LIVE);
    await withSite(open);

    const published = await open.gateway.publishCard(open.merchant.id, parcelCard);

    if (published.ok) throw new Error("a parcel's card was published on the live channel");
    expect(published.error.problems).toContainEqual(
      expect.objectContaining({ path: ["fulfillment"], code: "not_sold_yet" }),
    );
  });

  it("holds its orders to the time to ship, counted from the charge", () => {
    expect(policyFor(parcelCard, testConfig()).deadlines.asyncFulfillmentMs).toBe(172_800_000);
  });

  it("is a card this gateway can show an agent, once it may", () => {
    const shown = publicCardOf(parcelCard, {
      id: "itm_beans",
      as_of: "2026-10-09T09:00:00.000Z",
      seller: { name: "A roastery", site: "https://roastery.example" },
    });

    expect(
      checksBeforeSending(CatalogPageSchema).every(
        (check) => check.safeParse({ items: [shown] }).success,
      ),
    ).toBe(true);
  });
});
