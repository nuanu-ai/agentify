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
 * Once the merchant has the address, or the order ends without them, the
 * gateway lets go of it: the order says only when, and nothing on the
 * merchant's stream carries any of it any more.
 *
 * Each test puts the parcel's card in the store directly, as a card already
 * published would be, so that what a test is about is the purchase and not the
 * publishing door.
 */

import {
  type Card,
  CardSchema,
  type Order,
  type QuoteRequest,
  type QuoteResponse,
  type ShipTo,
} from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buyOverHttp,
  drawEverything,
  type Harness,
  harness,
  type Served,
  serve,
  theMerchantKey,
  workOnce,
  workUntilStopped,
} from "../testing/harness.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402.js";

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
const priced: QuoteResponse = {
  available: true,
  price: { amount: "21.00", currency: "USD" },
  as_of: "2026-08-26T10:15:00Z",
};

let open: { harnessed: Harness; served: Served } | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness(overrides);
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

let signed = 0;

/**
 * Priced with the merchant's worker answering, then paid with it stopped, so
 * the order the payment hands over is still on the stream to be read rather
 * than drawn by a worker with nothing to do with it.
 */
async function pricedThenPaid(
  harnessed: Harness,
  served: Served,
  itemId: string,
  body: { readonly priced: unknown; readonly paid: unknown },
) {
  const worker = workUntilStopped(harnessed, { onQuote: () => priced });
  const challenge = await served.call("POST", `/x402/${itemId}/purchase`, { body: body.priced });
  await worker.stop();
  const requirements = decodePaymentRequiredHeader(
    challenge.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
  ).accepts[0];
  if (requirements === undefined) throw new Error("no payment was offered");
  signed += 1;
  return served.call("POST", `/x402/${itemId}/purchase`, {
    body: body.paid,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: requirements,
        payload: { signature: `0xparcel${signed}` },
      }),
    },
  });
}

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

    const paid = await pricedThenPaid(harnessed, served, itemId, {
      priced: { params: {}, ship_to: address },
      paid: { params: {}, ship_to: address },
    });
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

    const paid = await pricedThenPaid(harnessed, served, itemId, {
      priced: { params: {}, ship_to: address },
      paid: { params: {} },
    });

    expect(paid.status).toBeLessThan(300);
    const [handedOver] = (await drawEverything(harnessed)).flatMap((envelope) =>
      envelope.kind === "order" ? [envelope.payload as Order] : [],
    );
    expect(handedOver?.ship_to).toStrictEqual(address);
  });
});

/** Everything the gateway keeps about one order, as one string to search. */
const keptOf = async (harnessed: Harness, orderId: string) =>
  JSON.stringify(await harnessed.store.orderById(orderId));

/** The parts of the address that say who and where, none of which may be kept. */
const whoAndWhere = [address.name, address.line_one, address.city, address.phone_number];

const theOrder = async (served: Served) => {
  const listed = await served.call("GET", "/v0/orders", { headers: asMerchant });
  const [order] = (listed.body as { orders: Order[] }).orders;
  if (order === undefined) throw new Error("the merchant has no order");
  return order;
};

/**
 * Everything on the merchant's stream, read off the queue itself rather than
 * through a poll: a poll hands nobody a parcel whose address is gone, so it
 * cannot show whether an envelope carrying that address is still there.
 */
const onTheStream = async (harnessed: Harness) =>
  JSON.stringify(
    (await harnessed.queue.draw(harnessed.merchant.id, 100, 0)).map((drawn) => drawn.envelope),
  );

const expectNothingOfTheAddressIn = (text: string) => {
  for (const part of whoAndWhere) {
    expect(text, part).not.toContain(part);
  }
};

describe("once the merchant has the address", () => {
  it("erases it when they take the order on, and the order then says only when", async () => {
    const { harnessed, served, itemId } = await started();
    await pricedThenPaid(harnessed, served, itemId, {
      priced: { params: {}, ship_to: address },
      paid: { params: {}, ship_to: address },
    });

    await workOnce(harnessed, { onOrder: () => ({ accepted: {} }) });

    const order = await theOrder(served);
    expect(order.ship_to).toStrictEqual({ erased_at: expect.any(String) });
    expect(Date.parse((order.ship_to as { erased_at: string }).erased_at)).toBe(harnessed.now());
    const kept = await keptOf(harnessed, order.id);
    for (const part of whoAndWhere) {
      expect(kept, part).not.toContain(part);
    }
  });

  it("takes the order off the merchant's stream when they take it on by the call", async () => {
    // The order was handed over and is still waiting on the stream when the
    // merchant takes it on with the accept call. Left there, a worker would be
    // handed the address after the gateway had said it let go of it.
    const { harnessed, served, itemId } = await started();
    await pricedThenPaid(harnessed, served, itemId, {
      priced: { params: {}, ship_to: address },
      paid: { params: {}, ship_to: address },
    });
    const order = await theOrder(served);

    const accepted = await served.call("POST", `/v0/orders/${order.id}/accept`, {
      headers: asMerchant,
      body: {},
    });
    expect(accepted.status).toBe(200);

    expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, order.id)).toBe(false);
    expectNothingOfTheAddressIn(await onTheStream(harnessed));
    expect((await theOrder(served)).ship_to).toStrictEqual({ erased_at: expect.any(String) });
  });

  it("deletes the price question nobody answered, with the order that ends unsold", async () => {
    // No worker is turning, so the question about the place the parcel goes
    // sits on the stream; the gateway's patience runs out and a parcel, whose
    // money moves at the purchase, is not sold at the card's price. The order
    // ends, and the question carrying its locality goes with it.
    const { harnessed, served, itemId } = await started({ QUOTE_RESPONSE_MS: "50" });

    await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {}, ship_to: address },
    });

    // An order that closed before it had a price is not in the merchant's
    // list, so what the gateway kept is read where it keeps it.
    const [record] = await harnessed.store.orders(harnessed.merchant.id);
    expect(record?.order.state).toBe("rejected");
    expect(record?.shipTo).toStrictEqual({ erasedAt: expect.any(Number) });
    expect(await drawEverything(harnessed)).toStrictEqual([]);
    const kept = await keptOf(harnessed, record?.order.id ?? "");
    for (const part of whoAndWhere) {
      expect(kept, part).not.toContain(part);
    }
  });
});

describe("once the address is gone, nothing puts it back", () => {
  /** A parcel paid for and waiting on the merchant's stream, with no worker turning. */
  const paidAndWaiting = async (overrides: Record<string, string> = {}) => {
    const { harnessed, served, itemId } = await started(overrides);
    await pricedThenPaid(harnessed, served, itemId, {
      priced: { params: {}, ship_to: address },
      paid: { params: {}, ship_to: address },
    });
    const order = await theOrder(served);
    return { harnessed, served, orderId: order.id };
  };

  const takeOn = (served: Served, orderId: string) =>
    served.call("POST", `/v0/orders/${orderId}/accept`, { headers: asMerchant, body: {} });

  it("is sent again by the sweep while it is still held, the whole address with it", async () => {
    // The control for the two below: a paid parcel whose hand-over went nowhere
    // still goes out again, under the hold, with the address the merchant
    // needs to send it.
    const { harnessed, orderId } = await paidAndWaiting();
    for (const drawn of await harnessed.queue.draw(harnessed.merchant.id, 10, 0)) {
      await harnessed.queue.finish(harnessed.merchant.id, drawn.handle);
    }
    harnessed.advance(harnessed.runtime.config.sweepDispatchGraceMs + 60_000);

    await harnessed.gateway.runner.sweep();

    const [again] = await harnessed.queue.draw(harnessed.merchant.id, 10, 0);
    if (again?.envelope.kind !== "order") throw new Error("no hand-over went out again");
    expect(again.envelope.payload.id).toBe(orderId);
    expect(again.envelope.payload.ship_to).toStrictEqual(address);
  });

  it("is put back by a poll whose hand-over failed while the address is still held", async () => {
    // The control for the put-back below: nobody took the order on, so the
    // envelope the poll could not hand over goes back on the stream.
    const { harnessed, orderId } = await paidAndWaiting();
    const deciding = harnessed.store.withOrder.bind(harnessed.store);
    let first = true;
    vi.spyOn(harnessed.store, "withOrder").mockImplementation(async (id, change, scope) => {
      if (first) {
        first = false;
        throw new Error("the database timed out");
      }
      return deciding(id, change, scope);
    });

    await harnessed.gateway.poll(harnessed.merchant.id, 0);

    expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, orderId)).toBe(true);
  });

  it("is not sent again by a sweep that read the order before it was taken on", async () => {
    // The sweep reads every open order first and works through the list, so an
    // order can be taken on between the reading and the sending. Sent from
    // what was read, the hand-over would go back on the stream with the
    // buyer's name, street and phone after the gateway had let go of them.
    const { harnessed, served, orderId } = await paidAndWaiting();
    const readBefore = await harnessed.store.openOrders();
    await takeOn(served, orderId);
    vi.spyOn(harnessed.store, "openOrders").mockResolvedValueOnce(readBefore);
    harnessed.advance(harnessed.runtime.config.sweepDispatchGraceMs + 60_000);

    await harnessed.gateway.runner.sweep();

    expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, orderId)).toBe(false);
    expectNothingOfTheAddressIn(await onTheStream(harnessed));
  });

  it("is not sent again by a sweep that read the order before a worker drew it", async () => {
    // The other half of the same reading: the order is still the merchant's to
    // take on, so its address is still here, but a worker has drawn it since
    // and the hand-over is recorded. A second one would spend a delivery the
    // merchant never failed, and put the address on the stream once more.
    const { harnessed, orderId } = await paidAndWaiting();
    const readBefore = await harnessed.store.openOrders();
    await harnessed.gateway.poll(harnessed.merchant.id, 0);
    vi.spyOn(harnessed.store, "openOrders").mockResolvedValueOnce(readBefore);
    harnessed.advance(harnessed.runtime.config.sweepDispatchGraceMs + 60_000);

    await harnessed.gateway.runner.sweep();

    expect((await harnessed.store.orderById(orderId))?.order.state).toBe("dispatched");
    expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, orderId)).toBe(false);
  });

  it("is not put back by a poll whose hand-over failed while the order was taken on", async () => {
    // A poll that cannot record a hand-over puts the envelope it drew back on
    // the stream. That envelope was built when the order was handed over, with
    // the whole address in it, and the merchant may take the order on while
    // the poll is failing.
    const { harnessed, served, orderId } = await paidAndWaiting();
    const deciding = harnessed.store.withOrder.bind(harnessed.store);
    let first = true;
    vi.spyOn(harnessed.store, "withOrder").mockImplementation(async (id, change, scope) => {
      if (first) {
        first = false;
        await takeOn(served, orderId);
        throw new Error("the database timed out");
      }
      return deciding(id, change, scope);
    });

    await harnessed.gateway.poll(harnessed.merchant.id, 0);
    await new Promise((resolve) =>
      setTimeout(resolve, harnessed.runtime.config.settleInFlightRetryMs + 20),
    );

    expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, orderId)).toBe(false);
    expectNothingOfTheAddressIn(await onTheStream(harnessed));
  });

  it("does not leave a price question that landed after its order ended", async () => {
    // The question goes out after the order is written. Should it land late —
    // the stream slow to take it — the order can end on the gateway's patience
    // first, its address erased, and a question written afterwards would carry
    // the place the parcel goes for as long as the queue keeps it.
    const { harnessed, served, itemId } = await started({ QUOTE_RESPONSE_MS: "50" });
    const staging = harnessed.queue.stage.bind(harnessed.queue);
    harnessed.queue.stage = async (merchantId, envelope, afterMs) => {
      if (envelope.kind === "quote_request") {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return staging(merchantId, envelope, afterMs);
    };

    await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {}, ship_to: address },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const [record] = await harnessed.store.orders(harnessed.merchant.id);
    expect(record?.shipTo).toStrictEqual({ erasedAt: expect.any(Number) });
    expect(await onTheStream(harnessed)).toBe("[]");
  });

  it("erases it when the time to ship runs out with the order never taken on", async () => {
    // The order comes to owe a refund without the merchant ever having had the
    // address, and the gateway lets go of it all the same: nobody can use it
    // now. The instant it reads is when it was erased, which is later than the
    // deadline it was erased for.
    const { harnessed, served } = await started();
    const quick = await harnessed.store.publishCard(
      harnessed.merchant.id,
      { ...parcelCard, merchant_item_id: "beans-quick", ship_within_seconds: 1 },
      harnessed.now(),
    );
    await pricedThenPaid(harnessed, served, quick.id, {
      priced: { params: {}, ship_to: address },
      paid: { params: {}, ship_to: address },
    });
    const orderId = (await theOrder(served)).id;
    harnessed.advance(5_000);

    await vi.waitFor(
      async () =>
        expect((await harnessed.store.orderById(orderId))?.order.state).toBe("refund_due"),
      { timeout: 3_000, interval: 20 },
    );

    const order = await theOrder(served);
    expect(order.ship_to).toStrictEqual({ erased_at: expect.any(String) });
    expect(Date.parse((order.ship_to as { erased_at: string }).erased_at)).toBe(harnessed.now());
    expect(await harnessed.queue.holdsOrder(harnessed.merchant.id, orderId)).toBe(false);
    expectNothingOfTheAddressIn(await keptOf(harnessed, orderId));
  });
});

describe("the address on a payment", () => {
  it("refuses a payment carrying an address that is not one, before anything else", async () => {
    const { harnessed, served, itemId } = await started();

    const paid = await buyOverHttp(
      harnessed,
      served,
      itemId,
      { onQuote: () => priced },
      {
        priced: { params: {}, ship_to: address },
        paid: { params: {}, ship_to: { ...address, country: "Indonesia" } },
      },
    );

    expect(paid.status).toBe(400);
    expect(JSON.stringify(paid.body)).toContain("country");
    expect(harnessed.facilitator.verifies).toHaveLength(0);
  });

  it("refuses an address on a payment for a product that is not shipped", async () => {
    const { harnessed, served } = await started();
    const ordinary = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: "room-101",
      title: "A room for the night",
      description: "One night in room 101",
      price: "80.00 USD",
      result: { access_code: "string" },
    });
    if (!ordinary.ok) throw new Error("the ordinary card would not publish");

    const paid = await buyOverHttp(
      harnessed,
      served,
      ordinary.id,
      {},
      { priced: { params: {} }, paid: { params: {}, ship_to: address } },
    );

    expect(paid.status).toBe(422);
    expect((paid.body as Refused).error.code).toBe("ship_to_does_not_fit");
    expect(harnessed.facilitator.verifies).toHaveLength(0);
  });
});

describe("the shipment", () => {
  /** A real carrier, and a number with its digits taken out. */
  const shipment = { carrier: "JNE", tracking_number: "0000000000000000" };

  /** A parcel paid for and taken on, as its merchant has it once they stored the address. */
  const takenOn = async () => {
    const { harnessed, served, itemId } = await started();
    await pricedThenPaid(harnessed, served, itemId, {
      priced: { params: {}, ship_to: address },
      paid: { params: {}, ship_to: address },
    });
    const orderId = (await theOrder(served)).id;
    await served.call("POST", `/v0/orders/${orderId}/accept`, { headers: asMerchant, body: {} });
    return { harnessed, served, orderId };
  };

  const ship = (served: Served, orderId: string, body: unknown) =>
    served.call("POST", `/v0/orders/${orderId}/deliver`, { headers: asMerchant, body });

  const statusOf = async (served: Served, orderId: string) =>
    (await served.call("GET", `/x402/orders/${orderId}/status`)).body as Record<string, unknown>;

  it("is recorded by the deliver call, and the agent reads that the parcel shipped", async () => {
    const { harnessed, served, orderId } = await takenOn();

    const shipped = await ship(served, orderId, shipment);

    expect(shipped.status).toBe(200);
    const status = await statusOf(served, orderId);
    expect(status.status).toBe("shipped");
    // Nothing reached the agent: the goods field stays empty, and the shipment
    // is where the parcel's record is, stamped with when it was recorded.
    expect(status.delivered).toBeNull();
    expect(status.shipment).toStrictEqual({
      ...shipment,
      shipped_at: new Date(harnessed.now()).toISOString(),
    });
    expect((await theOrder(served)).status).toBe("shipped");
    expect((await harnessed.store.receiptForOrder(orderId))?.outcome).toBe("shipped");
  });

  it("tells the agent the time to ship by once the order is paid, and that nothing has shipped", async () => {
    const { harnessed, served, itemId } = await started();
    await pricedThenPaid(harnessed, served, itemId, {
      priced: { params: {}, ship_to: address },
      paid: { params: {}, ship_to: address },
    });
    const order = await harnessed.store.orderById((await theOrder(served)).id);
    const paidAt = order?.order.timestamps.paidAt ?? 0;

    const status = await statusOf(served, order?.order.id ?? "");

    expect(status.status).toBe("in_progress");
    expect(status.shipment).toBeNull();
    expect(status.ship_by).toBe(new Date(paidAt + 172_800_000).toISOString());
  });

  it("answers the same shipment again as recorded, and refuses a different one", async () => {
    // A parcel cannot be sent twice safely, so a repeat is ordinary and a
    // second, different shipment is refused rather than taken in silence: a
    // corrected number would otherwise vanish without a word.
    const { served, orderId } = await takenOn();
    await ship(served, orderId, shipment);

    const again = await ship(served, orderId, shipment);
    const other = await ship(served, orderId, { ...shipment, tracking_number: "1111111111111111" });

    expect(again.status).toBe(200);
    expect(other.status).toBe(409);
    const refused = other.body as { error: { code: string; retryable: boolean } };
    expect(refused.error.code).toBe("shipment_already_recorded");
    expect(refused.error.retryable).toBe(false);
    expect(
      ((await statusOf(served, orderId)).shipment as Record<string, unknown>).tracking_number,
    ).toBe(shipment.tracking_number);
  });

  it("refuses goods in place of a shipment, and a shipment that says when it shipped", async () => {
    const { served, orderId } = await takenOn();

    const goods = await ship(served, orderId, { access_code: "SESAME" });
    const dated = await ship(served, orderId, { ...shipment, shipped_at: "2026-08-20T00:00:00Z" });

    for (const refused of [goods, dated]) {
      expect(refused.status).toBe(409);
      expect((refused.body as Refused).error.code).toBe("delivery_does_not_match_card");
    }
    expect((await statusOf(served, orderId)).status).toBe("in_progress");
  });

  it("is recorded from the handler's own answer as well", async () => {
    const { harnessed, served, itemId } = await started();
    await pricedThenPaid(harnessed, served, itemId, {
      priced: { params: {}, ship_to: address },
      paid: { params: {}, ship_to: address },
    });

    await workOnce(harnessed, { onOrder: () => ({ delivered: shipment }) });

    const orderId = (await theOrder(served)).id;
    expect((await statusOf(served, orderId)).status).toBe("shipped");
  });
});
