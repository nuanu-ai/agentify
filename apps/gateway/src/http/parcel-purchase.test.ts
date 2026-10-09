/**
 * Buying a parcel: the address beside the purchase (ADR-0032).
 *
 * The agent sends where the parcel goes in a block of its own, and only a
 * parcel's purchase takes one. The merchant's price question receives the
 * locality and nothing about who receives it, because a price question reaches
 * a merchant for purchases never made; the whole address reaches the merchant
 * only once the order is paid. And the address a purchase pays for is the one
 * it was priced for: a payment carrying another is refused before anything is
 * verified, with words to start again.
 *
 * Nothing can publish a parcel's card yet, so each test puts one in the store
 * directly, as a card already published would be.
 */

import {
  type Card,
  CardSchema,
  type Order,
  type QuoteRequest,
  type ShipTo,
} from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buyOverHttp,
  drawEverything,
  type Harness,
  harness,
  type Served,
  serve,
  theMerchantKey,
  workUntilStopped,
} from "../testing/harness.js";

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

const locality = { country: "ID", state: "BA", city: "Tabanan", postal_code: "82121" };

/** The merchant's price, shipping to the buyer's place included. */
const priced = { available: true as const, price: { amount: "21.00", currency: "USD" } };

let open: { harnessed: Harness; served: Served } | null = null;

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const started = async () => {
  const harnessed = await harness();
  const served = await serve(harnessed);
  open = { harnessed, served };
  const stored = await harnessed.store.publishCard(
    harnessed.merchant.id,
    parcelCard,
    harnessed.now(),
  );
  return { harnessed, served, itemId: stored.id };
};

const asMerchant = { authorization: `Bearer ${theMerchantKey("test")}` };

interface Refused {
  readonly error: { readonly code: string; readonly message: string };
}

describe("buying a parcel", () => {
  it("is refused without the address it goes to, in words that say so", async () => {
    const { served, itemId } = await started();

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(answered.status).toBe(422);
    expect((answered.body as Refused).error.code).toBe("ship_to_does_not_fit");
    expect((answered.body as Refused).error.message).toContain("ship_to");
  });

  it("refuses an address on a product that is not shipped", async () => {
    const { harnessed, served } = await started();
    const ordinary = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: "room-101",
      title: "A room for the night",
      description: "One night in room 101",
      price: "80.00 USD",
      result: { access_code: "string" },
    });
    if (!ordinary.ok) throw new Error("the ordinary card would not publish");

    const answered = await served.call("POST", `/x402/${ordinary.id}/purchase`, {
      body: { params: {}, ship_to: address },
    });

    expect(answered.status).toBe(422);
    expect((answered.body as Refused).error.code).toBe("ship_to_does_not_fit");
  });

  it("refuses an address that is not one, before it reaches anybody", async () => {
    const { served, itemId } = await started();

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {}, ship_to: { ...address, country: "Indonesia" } },
    });

    expect(answered.status).toBe(400);
    expect(JSON.stringify(answered.body)).toContain("country");
  });

  it("asks the merchant's price for the place it goes to, and tells them nothing about who", async () => {
    const { harnessed, served, itemId } = await started();
    const asked: QuoteRequest[] = [];
    const worker = workUntilStopped(harnessed, {
      onQuote: (question) => {
        asked.push(question as QuoteRequest);
        return priced;
      },
    });

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {}, ship_to: address },
    });
    await worker.stop();

    expect(answered.status).toBe(402);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.ship_to).toStrictEqual(locality);
    for (const whose of [address.name, address.line_one, address.phone_number]) {
      expect(JSON.stringify(asked)).not.toContain(whose);
    }
  });

  it("shows the merchant the place before payment, and the whole address once paid", async () => {
    const { harnessed, served, itemId } = await started();

    const paid = await buyOverHttp(
      harnessed,
      served,
      itemId,
      { onQuote: () => priced },
      { priced: { params: {}, ship_to: address }, paid: { params: {}, ship_to: address } },
    );
    expect(paid.status).toBeLessThan(300);

    const handedOver = (await drawEverything(harnessed)).flatMap((envelope) =>
      envelope.kind === "order" ? [envelope.payload as Order] : [],
    );
    expect(handedOver).toHaveLength(1);
    expect(handedOver[0]?.ship_to).toStrictEqual(address);

    const orderId = handedOver[0]?.id ?? "";
    const read = await served.call("GET", `/v0/orders/${orderId}`, { headers: asMerchant });
    expect((read.body as Order).ship_to).toStrictEqual(address);
  });

  it("shows an unpaid order's place to the merchant, and not the address", async () => {
    const { harnessed, served, itemId } = await started();
    const worker = workUntilStopped(harnessed, { onQuote: () => priced });
    await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {}, ship_to: address },
    });
    await worker.stop();

    const listed = await served.call("GET", "/v0/orders", { headers: asMerchant });
    const [order] = (listed.body as { orders: Order[] }).orders;

    expect(order?.ship_to).toStrictEqual(locality);
  });

  it("refuses a payment carrying another address before it is verified, and says to start again", async () => {
    const { harnessed, served, itemId } = await started();

    const paid = await buyOverHttp(
      harnessed,
      served,
      itemId,
      { onQuote: () => priced },
      {
        priced: { params: {}, ship_to: address },
        paid: { params: {}, ship_to: { ...address, line_one: "Jl. Pantai Nyanyi" } },
      },
    );

    expect(paid.status).toBe(409);
    expect((paid.body as Refused).error.code).toBe("ship_to_changed");
    expect((paid.body as Refused).error.message).toContain("new purchase");
    expect(harnessed.facilitator.verifies).toHaveLength(0);
  });

  it("pays for the address it was priced for when the payment carries none", async () => {
    const { harnessed, served, itemId } = await started();

    const paid = await buyOverHttp(
      harnessed,
      served,
      itemId,
      { onQuote: () => priced },
      { priced: { params: {}, ship_to: address }, paid: { params: {} } },
    );

    expect(paid.status).toBeLessThan(300);
    const [handedOver] = (await drawEverything(harnessed)).flatMap((envelope) =>
      envelope.kind === "order" ? [envelope.payload as Order] : [],
    );
    expect(handedOver?.ship_to).toStrictEqual(address);
  });
});
