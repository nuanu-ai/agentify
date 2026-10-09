/**
 * A card for a parcel at the gateway (ADR-0033), before a parcel can be sold.
 *
 * A parcel's order ends when its shipment is recorded, and recording one is
 * not built yet. So the gateway refuses to publish such a card at all, in
 * words that say why, rather than take orders it could never finish. What it
 * already does with one is what the rest of the mode is built on: the order is
 * held to the card's time to ship.
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

describe("a card for a parcel", () => {
  it("is refused at publishing until a shipment can be recorded, with words saying so", async () => {
    open = await harness();

    const published = await open.gateway.publishCard(open.merchant.id, parcelCard);

    expect(published.ok).toBe(false);
    expect(JSON.stringify(published)).toContain("shipment");
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
