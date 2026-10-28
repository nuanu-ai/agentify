/** Admission protects merchant work; waiting for a buyer does not own that work. */
import type { Card, QuoteRequest } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PurchaseAttempt } from "../app/gateway.js";
import type { Integration } from "../ports/store.js";
import { buyOverHttp, type Harness, harness, type Served, serve } from "../testing/harness.js";

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
let served: Served | undefined;
const pending: Promise<unknown>[] = [];

afterEach(async () => {
  vi.useRealTimers();
  h.gateway.quotes.giveUpAll();
  await Promise.allSettled(pending.splice(0));
  await served?.close();
  served = undefined;
  await h.stop();
});

async function started(overrides: Record<string, string> = {}, through: Integration = "api") {
  h = await harness(overrides);
  await h.store.switchIntegration(h.merchant.id, through);
  return (await h.store.publishCard(h.merchant.id, CARD, h.now(), through)).id;
}

/** A purchase asked straight of the gateway, whose answer a test can look at before it lands. */
function asked(itemId: string): { readonly answer: Promise<PurchaseAttempt>; landed(): boolean } {
  let done = false;
  const answer = h.gateway.beginPurchase(itemId, {}).finally(() => {
    done = true;
  });
  pending.push(answer);
  return { answer, landed: () => done };
}

/** The next price question on the merchant's stream, waiting for it to arrive. */
async function nextQuestion(merchantId = h.merchant.id, through: Integration = "api") {
  const { envelopes } = await h.gateway.poll(merchantId, 200, { through });
  const question = envelopes[0];
  if (question?.kind !== "quote_request") throw new Error("no price question was offered");
  return question.payload;
}

/** Four questions the merchant has drawn and not answered, which fill its gate. */
async function fill(itemId: string, through: Integration = "api"): Promise<QuoteRequest[]> {
  const held: QuoteRequest[] = [];
  for (let one = 0; one < 4; one += 1) asked(itemId);
  for (let one = 0; one < 4; one += 1) held.push(await nextQuestion(h.merchant.id, through));
  return held;
}

const namedPrice = (amount = "75.00") => ({
  available: true as const,
  price: { amount, currency: "USD" },
  as_of: new Date(h.now()).toISOString(),
});

/** Lets every promise that can move without a timer move. */
const settled = () => vi.advanceTimersByTimeAsync(0);

describe("the merchant's price gate", () => {
  it("answers a silent merchant's priced card as busy, to be asked again, before any order", async () => {
    const itemId = await started({ QUOTE_RESPONSE_MS: "1" });
    served = await serve(h);

    const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(refused.status).toBe(429);
    // A price check that did not answer may not answer the next time either,
    // so the agent is asked to wait longer than for a full gate.
    expect(refused.headers.get("retry-after")).toBe("10");
    expect(refused.body).toMatchObject({ error: { code: "seller_busy", retryable: true } });
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
    expect(h.facilitator.verifies).toHaveLength(0);
  });

  it.each(["api", "woocommerce"] as const)(
    "lets another merchant's priced sale through %s while one merchant's gate is full",
    async (through) => {
      // The questions held here outlast the test, so none of them can free a place.
      const itemId = await started({ QUOTE_RESPONSE_MS: "60000" }, through);
      served = await serve(h);
      const held = Array.from({ length: 4 }, () => asked(itemId));
      for (let one = 0; one < 4; one += 1) await nextQuestion(h.merchant.id, through);

      const other = await h.addMerchant("Another merchant");
      await h.store.switchIntegration(other.id, through);
      const offered = await h.store.publishCard(
        other.id,
        { ...CARD, fulfillment: "sync" },
        h.now(),
        through,
      );
      const bought = await buyOverHttp(h, served, offered.id, {
        merchantId: other.id,
        through,
        onQuote: () => namedPrice("70.00"),
        onOrder: () => ({ delivered: { access_code: "SESAME" } }),
      });

      expect(bought.status).toBe(200);
      expect(bought.body).toMatchObject({ status: "delivered", payment_status: "paid" });
      // The other merchant's own answer set the price, so its question was asked.
      expect(h.facilitator.settles.map((charge) => charge.amount)).toStrictEqual(["70.00"]);
      expect(held.some((question) => question.landed())).toBe(false);
    },
  );

  it("makes a question wait for a place and asks it once an answer frees one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const itemId = await started();
    const [first] = await fill(itemId);
    if (first === undefined) throw new Error("the gate was not filled");
    const fifth = asked(itemId);
    await settled();
    expect(fifth.landed()).toBe(false);
    expect((await h.gateway.poll(h.merchant.id, 0)).envelopes).toStrictEqual([]);

    expect(await h.gateway.answerQuote(h.merchant.id, first.price_id, namedPrice())).toMatchObject({
      used: true,
    });
    const question = await nextQuestion();
    await h.gateway.answerQuote(h.merchant.id, question.price_id, namedPrice());

    expect((await fifth.answer).step).toBe("pay");
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
  });

  it("refuses a question whose wait for a place ends inside the price deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const itemId = await started();
    await fill(itemId);
    const fifth = asked(itemId);
    await settled();
    expect(fifth.landed()).toBe(false);

    // The four held questions run out at the deadline; the fifth's wait ends first.
    await vi.advanceTimersByTimeAsync(h.runtime.config.deadlines.quoteResponseMs);

    expect(await fifth.answer).toMatchObject({ step: "seller_busy" });
    expect((await h.gateway.poll(h.merchant.id, 0)).envelopes).toStrictEqual([]);
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
  });

  it("uses the card price on synchronous overflow without sending another question", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const itemId = await started();
    const held = await fill(itemId);
    const synchronous = await h.store.publishCard(
      h.merchant.id,
      { ...CARD, merchant_item_id: "room-102", fulfillment: "sync" },
      h.now(),
    );
    const overflow = asked(synchronous.id);
    await vi.advanceTimersByTimeAsync(h.runtime.config.deadlines.quoteResponseMs);

    const answer = await overflow.answer;
    if (answer.step !== "pay") throw new Error("the synchronous card was not priced");
    expect(answer.order.order.quoteSource).toBe("card_snapshot");
    expect(held.every((question) => question.merchant_item_id === CARD.merchant_item_id)).toBe(
      true,
    );
    expect((await h.gateway.poll(h.merchant.id, 0)).envelopes).toStrictEqual([]);
  });

  it("asks at most sixteen questions a second and asks the next once the second has passed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const itemId = await started();
    for (let one = 0; one < 16; one += 1) {
      const buying = asked(itemId);
      const question = await nextQuestion();
      await h.gateway.answerQuote(h.merchant.id, question.price_id, namedPrice());
      expect((await buying.answer).step).toBe("pay");
    }
    const seventeenth = asked(itemId);
    await settled();
    expect(seventeenth.landed()).toBe(false);
    expect((await h.gateway.poll(h.merchant.id, 0)).envelopes).toStrictEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    const question = await nextQuestion();
    await h.gateway.answerQuote(h.merchant.id, question.price_id, namedPrice());

    expect((await seventeenth.answer).step).toBe("pay");
    expect(await h.store.orders(h.merchant.id)).toStrictEqual([]);
  });

  it("never hands a question out after the purchase stopped waiting for its price", async () => {
    const itemId = await started({ QUOTE_RESPONSE_MS: "1" });
    await h.gateway.beginPurchase(itemId, {});
    expect(await h.queue.draw(h.merchant.id, 1, 0)).toStrictEqual([]);
    expect((await h.gateway.poll(h.merchant.id, 0)).envelopes).toStrictEqual([]);
  });
});
