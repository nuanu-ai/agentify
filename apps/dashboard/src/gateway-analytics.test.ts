/**
 * What the dashboard's calls on the gateway are recorded as: a person signed
 * in to the dashboard did them, unlike the same calls made with a merchant's
 * key, which are the merchant's code. The analytics team tells a person's
 * setup from an integration's by this alone.
 */

import type { AnalyticsEvent } from "@agentify/gateway/analytics";
import { type Harness, harness } from "@agentify/gateway/testing";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayFor } from "./gateway.js";

let open: Harness | null = null;

afterEach(async () => {
  await open?.stop();
  open = null;
});

const card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

describe("the dashboard's calls on the gateway, as analytics records them", () => {
  it("records a person's publication, pauses and seller name as the person's, through the dashboard", async () => {
    open = await harness({
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "https://x402.org/facilitator",
    });
    const merchantId = open.merchant.id;
    const client = gatewayFor(open.gateway, { merchantId, email: "owner@example.com" });

    // The dashboard publishes only what it imports from a shop.
    await client.sellThrough("woocommerce");
    const published = await client.publishCard(card);
    const item = published.ok && published.document.ok ? published.document.id : "";
    await client.pauseCard(item, true);
    await client.setSelling(false);
    await client.setSellerName("A name of its own");
    await client.setSellerSite("https://shop.example.com");

    const recorded: AnalyticsEvent[] = open.store.recordedAnalytics.map(({ event }) => event);
    expect(recorded.map((event) => [event.name, event.actor, event.source])).toStrictEqual([
      ["agc_card_publish_result", "human", "dashboard"],
      ["agc_selling_changed", "human", "dashboard"],
      ["agc_selling_changed", "human", "dashboard"],
      ["agc_setup_result", "human", "dashboard"],
      ["agc_setup_result", "human", "dashboard"],
    ]);
  });
});
