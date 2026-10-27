/** Admission protects merchant work; waiting for a buyer does not own that work. */
import type { Card, Integration, QuoteRequest } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  workUntilStopped,
} from "../testing/harness.js";

const CARD: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "async",
  price_check: "handler",
};
let h: Harness;
let served: Served;
const pending: Promise<unknown>[] = [];

afterEach(async () => {
  h.gateway.quotes.giveUpAll();
  await Promise.allSettled(pending.splice(0));
  await served.close();
  await h.stop();
});

async function started(through: Integration = "api") {
  h = await harness({ QUOTE_RESPONSE_MS: "1000" });
  served = await serve(h);
  await h.store.switchIntegration(h.merchant.id, through);
  return (await h.store.publishCard(h.merchant.id, CARD, h.now(), through)).id;
}
const ask = (id: string) => served.call("POST", `/x402/${id}/purchase`, { body: { params: {} } });
async function fill(itemId: string) {
  for (let one = 0; one < 4; one += 1) pending.push(ask(itemId));
  await vi.waitFor(async () => expect(await h.store.orders(h.merchant.id)).toHaveLength(4));
}
const namedPrice = () => ({
  available: true as const,
  price: { amount: "75.00", currency: "USD" },
  as_of: new Date(h.now()).toISOString(),
});

async function nextQuestion(through: Integration = "api"): Promise<QuoteRequest> {
  const { envelopes } = await h.gateway.poll(h.merchant.id, 0, { through });
  const question = envelopes[0];
  if (question?.kind !== "quote_request") throw new Error("no price question was offered");
  return question.payload;
}

describe("the merchant's price gate", () => {
  it.each(["api", "woocommerce"] as const)(
    "refuses overflow through %s before writing an order while another merchant completes a sale",
    async (through) => {
      const itemId = await started(through);
      await fill(itemId);
      const refused = await ask(itemId);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("2");
      expect(refused.body).toMatchObject({ error: { code: "seller_busy", retryable: true } });
      expect(await h.store.orders(h.merchant.id)).toHaveLength(4);

      const other = await h.addMerchant("Another merchant");
      await h.store.switchIntegration(other.id, through);
      const offered = await h.store.publishCard(
        other.id,
        { ...CARD, price_check: undefined, fulfillment: "sync" },
        h.now(),
        through,
      );
      let finished = 0;
      for (const request of pending)
        request.then(() => {
          finished += 1;
        });
      const bought = await buyOverHttp(h, served, offered.id, {
        merchantId: other.id,
        through,
        onOrder: () => ({ delivered: { access_code: "SESAME" } }),
      });
      expect(bought.status).toBe(200);
      expect(bought.body).toMatchObject({
        status: "delivered",
        payment_status: "paid",
        delivered: { access_code: "SESAME" },
      });
      expect(finished).toBe(0);
    },
  );

  it("uses the card price on synchronous overflow without sending another question", async () => {
    const itemId = await started();
    await fill(itemId);
    const synchronous = await h.store.publishCard(
      h.merchant.id,
      { ...CARD, merchant_item_id: "room-102", fulfillment: "sync" },
      h.now(),
    );
    const answer = await ask(synchronous.id);
    expect(answer.status).toBe(402);
    const questions = [];
    for (let one = 0; one < 5; one += 1) {
      questions.push(...(await h.gateway.poll(h.merchant.id, 0)).envelopes);
    }
    expect(questions).toHaveLength(4);
    expect(
      questions.every(
        (envelope) =>
          envelope.kind === "quote_request" &&
          envelope.payload.merchant_item_id === CARD.merchant_item_id,
      ),
    ).toBe(true);
  });

  it("never hands a question out after the purchase stopped waiting for its price", async () => {
    const itemId = await started();
    await ask(itemId);
    expect((await h.gateway.poll(h.merchant.id, 0)).envelopes).toStrictEqual([]);
  });

  it("admits another question as soon as one answer releases capacity", async () => {
    const itemId = await started();
    await fill(itemId);
    const question = await nextQuestion();
    expect(
      await h.gateway.answerQuote(h.merchant.id, question.price_id, namedPrice()),
    ).toMatchObject({ used: true });
    await Promise.race(pending);
    pending.push(ask(itemId));
    await vi.waitFor(async () => expect(await h.store.orders(h.merchant.id)).toHaveLength(5));
  });

  it("bounds a burst of completed questions and admits the next window", async () => {
    const itemId = await started();
    const worker = workUntilStopped(h, { onQuote: namedPrice });
    try {
      for (let one = 0; one < 16; one += 1) expect((await ask(itemId)).status).toBe(402);
      const refused = await ask(itemId);
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ error: { code: "seller_busy" } });
      expect(await h.store.orders(h.merchant.id)).toHaveLength(16);
      h.advance(1000);
      expect((await ask(itemId)).status).toBe(402);
    } finally {
      await worker.stop();
    }
  });
});
