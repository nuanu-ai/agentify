import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness, type Served, serve } from "../testing/harness.js";

const card: Card = {
  merchant_item_id: "esim-7d",
  title: "Seven days of data",
  description: "Seven days of mobile data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
};

let h: Harness;
let server: Served;
afterEach(async () => {
  await server?.close();
  await h?.stop();
});

async function order() {
  h = await harness();
  server = await serve(h);
  const published = await h.gateway.publishCard(h.merchant.id, card);
  if (!published.ok) throw new Error("card refused");
  const offered = await h.gateway.beginPurchase(published.id, {});
  if (offered.step !== "pay") throw new Error("price missing");
  return offered.order.order.id;
}

describe("the authenticated merchant closure", () => {
  it("continues to report an unresolved original payment after closure, then its actual outcome", async () => {
    const id = await order();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(id, "PAYMENT", "fp-original");
    const headers = { authorization: `Bearer ${h.merchant.key}` };
    expect(
      (await server.call("POST", `/v0/orders/${id}/close`, { headers, body: {} })).body,
    ).toEqual({ ok: true });
    const pending = await h.store.orderById(id);
    if (pending?.paymentAttempt === undefined) throw new Error("original payment attempt missing");
    for (const path of [`/v0/orders/${id}`, `/x402/orders/${id}/status`]) {
      expect((await server.call("GET", path, { headers })).body).toMatchObject({
        status: "payment_unresolved",
        payment_status: "unresolved",
        merchant_closure: { closed_at: new Date(h.now()).toISOString() },
      });
    }
    await h.gateway.runner.completePaymentAttempt(
      id,
      pending.paymentAttempt.id,
      { settled: true, transaction: "original-transaction" },
      "facilitator",
    );
    const completed = await server.call("GET", `/x402/orders/${id}/status`);
    expect(completed.body).toMatchObject({
      status: "fulfillment_closed",
      payment_status: "paid",
      delivered: null,
    });
    expect(h.facilitator.settles).toHaveLength(1);
    expect(await h.store.receipts(h.merchant.id)).toEqual([]);
  });

  it("tells the merchant of a payment completed after closure and keeps the order on their open list until they close it again", async () => {
    const id = await order();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(id, "PAYMENT", "fp-original");
    const headers = { authorization: `Bearer ${h.merchant.key}` };
    const close = (message: string) =>
      server.call("POST", `/v0/orders/${id}/close`, { headers, body: { message } });
    const openIds = async () =>
      (
        (await server.call("GET", "/v0/orders?open=true", { headers })).body as {
          orders: { id: string }[];
        }
      ).orders.map((one) => one.id);
    expect((await close("Your payment did not go through.")).body).toEqual({ ok: true });
    const pending = await h.store.orderById(id);
    if (pending?.paymentAttempt === undefined) throw new Error("original payment attempt missing");
    await h.gateway.poll(h.merchant.id, 0);

    await h.gateway.runner.completePaymentAttempt(
      id,
      pending.paymentAttempt.id,
      { settled: true, transaction: "original-transaction" },
      "facilitator",
    );

    expect((await h.gateway.poll(h.merchant.id, 0)).envelopes).toMatchObject([
      {
        kind: "order_event",
        payload: {
          type: "order.unfulfilled",
          order_id: id,
          price: { amount: "12.00", currency: "USD" },
          reason: "paid_after_closure",
        },
      },
    ]);
    expect(await openIds()).toEqual([id]);
    expect((await server.call("GET", `/v0/orders/${id}`, { headers })).body).toMatchObject({
      status: "fulfillment_closed",
      payment_status: "paid",
      merchant_closure: { message: "Your payment did not go through." },
    });

    h.advance(60_000);
    expect((await close("Your payment arrived late; we returned it.")).body).toEqual({ ok: true });
    expect(await openIds()).toEqual([]);
    expect((await server.call("GET", `/v0/orders/${id}`, { headers })).body).toMatchObject({
      status: "fulfillment_closed",
      payment_status: "paid",
      merchant_closure: {
        closed_at: new Date(h.now()).toISOString(),
        message: "Your payment arrived late; we returned it.",
      },
    });
    expect((await close("Changed")).body).toEqual({ ok: true });
    expect((await server.call("GET", `/v0/orders/${id}`, { headers })).body).toMatchObject({
      merchant_closure: { message: "Your payment arrived late; we returned it." },
    });
    expect(h.facilitator.settles).toHaveLength(1);
    expect(await h.store.receipts(h.merchant.id)).toEqual([]);
  });

  it("preserves its first attributed message and exposes payment facts on both read views", async () => {
    const id = await order();
    const headers = { authorization: `Bearer ${h.merchant.key}` };
    const path = `/v0/orders/${id}/close`;
    expect(
      (await server.call("POST", path, { headers, body: { message: "We agreed an offset." } }))
        .body,
    ).toEqual({ ok: true });
    const first = await h.store.orderById(id);
    expect(
      (await server.call("POST", path, { headers, body: { message: "Changed" } })).body,
    ).toEqual({ ok: true });
    expect((await h.store.orderById(id))?.order).toEqual(first?.order);
    for (const readPath of [`/v0/orders/${id}`, `/x402/orders/${id}/status`]) {
      const response = await server.call("GET", readPath, { headers });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({
        status: "fulfillment_closed",
        payment_status: "not_paid",
        merchant_closure: {
          closed_at: new Date(h.now()).toISOString(),
          message: "We agreed an offset.",
        },
      });
      expect(JSON.stringify(response.body)).not.toContain(first?.paymentRef);
    }
  });

  it("requires the owner's key and hides both a private payment reference and other merchants' orders", async () => {
    const id = await order();
    const stranger = await h.addMerchant("Another merchant");
    const ownOrder = await h.store.orderById(id);
    if (ownOrder === null) throw new Error("order missing");
    const privateRef = ownOrder.paymentRef;
    const unknown = await server.call("POST", "/v0/orders/ord_missing/close", {
      headers: { authorization: `Bearer ${stranger.key}` },
      body: {},
    });
    for (const other of [id, privateRef]) {
      const response = await server.call("POST", `/v0/orders/${other}/close`, {
        headers: { authorization: `Bearer ${stranger.key}` },
        body: {},
      });
      expect(response.status).toBe(404);
      expect(response.body).toEqual(unknown.body);
    }
    expect((await server.call("POST", `/v0/orders/${id}/close`, { body: {} })).status).toBe(401);
    expect((await h.store.orderById(id))?.order.state).toBe("quoted");
  });

  it.each([{ message: " " }, { message: "x".repeat(2001) }, { message: 42 }, { refunded: true }])(
    "refuses malformed claims without changing the order: %j",
    async (body) => {
      const id = await order();
      const before = await h.store.orderById(id);
      const response = await server.call("POST", `/v0/orders/${id}/close`, {
        headers: { authorization: `Bearer ${h.merchant.key}` },
        body,
      });
      expect(response.status).toBe(400);
      expect((await h.store.orderById(id))?.order).toEqual(before?.order);
    },
  );

  it("refuses to close an order that ended without a charge, and the buyer's agent reads the same ending", async () => {
    const id = await order();
    h.facilitator.willSettle({ settled: false, reason: "the transfer reverted" });
    await h.gateway.payPurchase(id, "PAYMENT", "fp-original");
    const headers = { authorization: `Bearer ${h.merchant.key}` };
    const before = await server.call("GET", `/x402/orders/${id}/status`);
    expect(before.body).toMatchObject({ status: "rejected", payment_status: "not_paid" });

    const response = await server.call("POST", `/v0/orders/${id}/close`, {
      headers,
      body: { message: "Cancelled." },
    });
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "nothing_to_close", retryable: false },
    });
    expect((response.body as { error: { message: string } }).error.message).toMatch(
      /ended without a charge.*nothing to close/,
    );
    expect((await server.call("GET", `/x402/orders/${id}/status`)).body).toStrictEqual(before.body);
  });

  it("refuses to close a delivered order, saying its fulfillment is complete", async () => {
    const id = await order();
    await h.gateway.payPurchase(id, "PAYMENT", "fp-original");
    await h.gateway.deliverOrder(h.merchant.id, id, { activation_code: "BOUGHT" });
    const response = await server.call("POST", `/v0/orders/${id}/close`, {
      headers: { authorization: `Bearer ${h.merchant.key}` },
      body: {},
    });
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "fulfillment_complete", retryable: false },
    });
    expect((response.body as { error: { message: string } }).error.message).toMatch(
      /delivered.*not changed/,
    );
    expect((await h.store.orderById(id))?.order.state).toBe("delivered");
  });

  it.each([true, false])(
    "serializes closure against delivery, with a single public result (close first=%s)",
    async (closeFirst) => {
      const id = await order();
      await h.gateway.payPurchase(id, "PAYMENT", "fp-original");
      const close = () => h.gateway.closeOrder(h.merchant.id, id, {});
      const deliver = () =>
        h.gateway.deliverOrder(h.merchant.id, id, { activation_code: "BOUGHT" });
      const [first, second] = await Promise.all(
        closeFirst ? [close(), deliver()] : [deliver(), close()],
      );
      const final = await h.store.orderById(id);
      const wasClosed = final?.order.state === "fulfillment_closed";
      const closed = closeFirst ? first : second;
      const delivered = closeFirst ? second : first;
      expect(closed).toMatchObject(
        wasClosed
          ? { ok: true }
          : { ok: false, error: { code: "fulfillment_complete", retryable: false } },
      );
      expect(delivered).toMatchObject(
        wasClosed
          ? { ok: false, error: { code: "fulfillment_closed", retryable: false } }
          : { ok: true },
      );
      expect(final?.delivery).toEqual(wasClosed ? null : { activation_code: "BOUGHT" });
      expect(await h.store.receipts(h.merchant.id)).toHaveLength(wasClosed ? 0 : 1);
      expect((await h.gateway.poll(h.merchant.id, 0)).envelopes).toEqual([]);
      expect(h.facilitator.settles).toHaveLength(1);
    },
  );
});
