/**
 * What an operator reads of a purchase: how long each party took, which gate
 * turned it away, and what it was told to wait for, and never whose purchase
 * it was.
 */
import { telemetry } from "@agentify/observability/source";
import type { Card, QuoteRequest, QuoteResponse } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PurchaseAttempt } from "../app/gateway.js";
import { PayerReads } from "../app/payer-proof.js";
import type { Integration } from "../ports/store.js";
import {
  type Call,
  type Harness,
  harness,
  type Served,
  serve,
  type WorkerBehaviour,
  workUntilStopped,
} from "../testing/harness.js";
import { aWallet, signedPayment } from "../testing/signed-payment.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402.js";

const CARD: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "async",
};
const BUYER = aWallet("the buyer");

let h: Harness | undefined;
let served: Served | undefined;
const pending: Promise<unknown>[] = [];
const releases: (() => void)[] = [];
const workers: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const release of releases.splice(0)) release();
  h?.gateway.quotes.giveUpAll();
  await Promise.allSettled(pending.splice(0));
  for (const worker of workers.splice(0)) await worker.stop();
  await served?.close();
  served = undefined;
  await h?.stop();
  h = undefined;
});

function running(): Harness {
  if (h === undefined) throw new Error("no gateway was started");
  return h;
}

async function started(
  card: Partial<Card> = {},
  options: {
    readonly overrides?: Record<string, string>;
    readonly through?: Integration;
    readonly worker?: WorkerBehaviour;
  } = {},
): Promise<string> {
  const through = options.through ?? "api";
  h = await harness(options.overrides);
  await h.store.switchIntegration(h.merchant.id, through);
  served = await serve(h);
  const itemId = (await h.store.publishCard(h.merchant.id, { ...CARD, ...card }, h.now(), through))
    .id;
  if (options.worker !== undefined) {
    workers.push(workUntilStopped(h, { through, ...options.worker }));
  }
  return itemId;
}

function calling(): Served {
  if (served === undefined) throw new Error("no gateway is listening");
  return served;
}

async function priced(itemId: string): Promise<PaymentRequirements> {
  const answer = await calling().call("POST", `/x402/${itemId}/purchase`, {
    body: { params: {} },
  });
  expect(answer.status).toBe(402);
  const offer = decodePaymentRequiredHeader(answer.headers.get(PAYMENT_REQUIRED_HEADER) ?? "")
    .accepts[0];
  if (offer === undefined) throw new Error("no price was named");
  return offer;
}

function paid(itemId: string, offer: PaymentRequirements, nonce: string): Promise<Call> {
  const gateway = running();
  const call = signedPayment(BUYER, offer, {
    nonce,
    validBefore: gateway.now() + offer.maxTimeoutSeconds * 1_000,
  }).then((payment) =>
    calling().call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
    }),
  );
  pending.push(call);
  return call;
}

/** The payment chain's endpoint, answering every read of a payer as `read` does. */
function chainAnswering(read: () => Promise<{ held: bigint; used: boolean }>): void {
  Object.assign(running().runtime, {
    balances: {
      balance: async () => (await read()).held,
      payerState: read,
    },
  });
}
const PLENTY = { held: 1_000_000_000n, used: false };

const namedPrice = (): QuoteResponse => ({
  available: true,
  price: { amount: "75.00", currency: "USD" },
  as_of: new Date(running().now()).toISOString(),
});

type Labels = Readonly<Record<string, string>>;

/** How often a metric was recorded under exactly these labels, and the seconds it summed. */
async function read(name: string, labels: Labels): Promise<{ times: number; seconds: number }> {
  const metric = (await telemetry.registry.getMetricsAsJSON()).find((one) => one.name === name);
  const exactly = (found: Partial<Record<string, string | number>>) => {
    const { le: _bucket, ...rest } = found;
    const keys = Object.keys(rest);
    return (
      keys.length === Object.keys(labels).length &&
      keys.every((key) => String(rest[key]) === labels[key])
    );
  };
  const value = (metricName: string) =>
    metric?.values.find(
      (one) =>
        ("metricName" in one ? one.metricName : name) === metricName &&
        !("le" in one.labels) &&
        exactly(one.labels),
    )?.value ?? 0;
  return metric?.type === "histogram"
    ? { times: value(`${name}_count`), seconds: value(`${name}_sum`) }
    : { times: value(name), seconds: 0 };
}

/** What a metric gains under these labels from now until the returned function is called. */
async function watching(name: string, labels: Labels = {}) {
  const before = await read(name, labels);
  return async () => {
    const after = await read(name, labels);
    return { times: after.times - before.times, seconds: after.seconds - before.seconds };
  };
}

describe("the merchant's price, timed", () => {
  it.each([
    {
      outcome: "answered",
      through: "api",
      answer: (): QuoteResponse => namedPrice(),
    },
    {
      outcome: "unavailable",
      through: "api",
      answer: (): QuoteResponse => ({
        available: false,
        as_of: new Date(running().now()).toISOString(),
      }),
    },
    {
      outcome: "answered",
      through: "woocommerce",
      answer: (): QuoteResponse => namedPrice(),
    },
  ] as const)(
    "times a price $outcome through $through from the question to its answer",
    async ({ outcome, through, answer }) => {
      const itemId = await started(
        { price_check: "handler" },
        {
          through,
          worker: {
            onQuote: () => {
              running().advance(1_500);
              return answer();
            },
          },
        },
      );
      const answers = await watching("agentify_price_answer_duration_seconds", {
        outcome,
        integration: through,
      });

      await calling().call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } });

      const moved = await answers();
      expect(moved.times).toBe(1);
      expect(moved.seconds).toBeCloseTo(1.5, 6);
    },
  );

  it("counts a price check that named no price, and the longer wait the buyer is told", async () => {
    const itemId = await started(
      { price_check: "handler" },
      { overrides: { QUOTE_RESPONSE_MS: "1" } },
    );
    const silent = await watching("agentify_price_answer_duration_seconds", {
      outcome: "silent",
      integration: "api",
    });
    const retries = await watching("agentify_retry_after_answers_total", {
      answer: "seller_busy",
      retry_after_seconds: "10",
    });

    const refused = await calling().call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("10");
    expect((await silent()).times).toBe(1);
    expect((await retries()).times).toBe(1);
  });

  it("counts a question turned away by a merchant's full price gate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const itemId = await started({ price_check: "handler" });
    const gateway = running().gateway;
    const asked = (): Promise<PurchaseAttempt> => {
      const answer = gateway.beginPurchase(itemId, {});
      pending.push(answer);
      return answer;
    };
    const drawn: QuoteRequest[] = [];
    for (let one = 0; one < 4; one += 1) void asked();
    while (drawn.length < 4) {
      const { envelopes } = await gateway.poll(running().merchant.id, 200);
      for (const envelope of envelopes)
        if (envelope.kind === "quote_request") drawn.push(envelope.payload);
    }
    const refusals = await watching("agentify_gate_refusals_total", { gate: "price" });

    const fifth = asked();
    await vi.advanceTimersByTimeAsync(running().runtime.config.deadlines.quoteResponseMs);

    expect(await fifth).toMatchObject({ step: "seller_busy" });
    expect((await refusals()).times).toBe(1);
  });
});

describe("a payment, timed", () => {
  it("measures the time from a price being named to its payment's arrival, a late one included", async () => {
    const itemId = await started();
    const ttlMs = running().runtime.config.deadlines.quoteTtlMs;
    const arrivals = await watching("agentify_price_to_payment_seconds");

    const inTime = await priced(itemId);
    running().advance(20_000);
    expect((await paid(itemId, inTime, "0x01")).status).toBeLessThan(300);
    const late = await priced(itemId);
    running().advance(ttlMs + 1_000);
    expect((await paid(itemId, late, "0x02")).status).toBe(409);

    const moved = await arrivals();
    expect(moved.times).toBe(2);
    expect(moved.seconds).toBeCloseTo(20 + ttlMs / 1_000 + 1, 6);
  });

  it.each([
    { lane: "proven", outcome: "verified", chain: true, script: () => undefined },
    { lane: "unproven", outcome: "verified", chain: false, script: () => undefined },
    {
      lane: "unproven",
      outcome: "refused",
      chain: false,
      script: () => running().facilitator.willRefuseVerification("insufficient_funds"),
    },
    {
      lane: "unproven",
      outcome: "no_verdict",
      chain: false,
      script: () =>
        running().facilitator.willVerify({
          verified: "unknown",
          cause: "no_answer",
          failure: "the payment layer did not answer",
        }),
    },
  ] as const)(
    "times the payment layer's $outcome check of a payment in the $lane lane",
    async ({ lane, outcome, chain, script }) => {
      const itemId = await started();
      if (chain) chainAnswering(async () => PLENTY);
      script();
      const offer = await priced(itemId);
      const checks = await watching("agentify_payment_verify_duration_seconds", { lane, outcome });
      const release = running().facilitator.holdVerification();
      releases.push(release);

      const paying = paid(itemId, offer, "0x01");
      await vi.waitFor(() => expect(running().facilitator.verifies).toHaveLength(1));
      running().advance(3_000);
      release();
      await paying;

      const moved = await checks();
      expect(moved.times).toBe(1);
      expect(moved.seconds).toBeCloseTo(3, 6);
    },
  );

  it("times the check of a new payment for goods held after their charge failed", async () => {
    const itemId = await started(
      { fulfillment: "sync" },
      { worker: { onOrder: () => ({ delivered: { access_code: "SESAME" } }) } },
    );
    running().facilitator.willSettle(
      { settled: false, reason: "the wallet could not pay" },
      { settled: true, transaction: "0xpaid" },
    );
    const offer = await priced(itemId);
    await paid(itemId, offer, "0x01");
    const [held] = await running().store.orders(running().merchant.id);
    expect(held?.order.state).toBe("delivered_unpaid");
    const checks = await watching("agentify_payment_verify_duration_seconds", {
      lane: "unproven",
      outcome: "verified",
    });
    const release = running().facilitator.holdVerification();
    releases.push(release);

    const again = paid(itemId, offer, "0x02");
    await vi.waitFor(() => expect(running().facilitator.verifies).toHaveLength(2));
    running().advance(3_000);
    release();
    expect((await again).status).toBe(200);

    const moved = await checks();
    expect(moved.times).toBe(1);
    expect(moved.seconds).toBeCloseTo(3, 6);
  });

  it("times the admission's transaction, and counts one that failed", async () => {
    const itemId = await started();
    const store = running().store;
    const admit = store.admitOrder.bind(store);
    store.admitOrder = async (accepted) => {
      running().advance(250);
      return admit(accepted);
    };
    const admitted = await watching("agentify_payment_admission_duration_seconds", {
      result: "admitted",
    });
    expect((await paid(itemId, await priced(itemId), "0x01")).status).toBeLessThan(300);
    const timed = await admitted();
    expect(timed.times).toBe(1);
    expect(timed.seconds).toBeCloseTo(0.25, 6);

    store.admitOrder = () =>
      Promise.reject(
        Object.assign(new Error("no connection"), { passing: true, nothingWritten: true }),
      );
    const failed = await watching("agentify_payment_admission_duration_seconds", {
      result: "failed",
    });
    const retries = await watching("agentify_retry_after_answers_total", {
      answer: "not_checked_now",
      retry_after_seconds: "2",
    });
    const refused = await paid(itemId, await priced(itemId), "0x02");
    expect(refused.status).toBe(503);
    expect((await failed()).times).toBe(1);
    expect((await retries()).times).toBe(1);
  });

  it.each([
    { card: "async", mode: "on_purchase", outcome: "settled", script: () => undefined },
    { card: "sync", mode: "after_fulfillment", outcome: "settled", script: () => undefined },
    {
      card: "async",
      mode: "on_purchase",
      outcome: "refused",
      script: () => running().facilitator.willSettle({ settled: false, reason: "refused" }),
    },
    {
      card: "async",
      mode: "on_purchase",
      outcome: "unknown",
      script: () => running().facilitator.willSettle({ settled: "unknown", reason: "no answer" }),
    },
  ] as const)(
    "times a charge $outcome on a card charged $mode until the payment layer answers",
    async ({ card, mode, outcome, script }) => {
      const itemId = await started(
        { fulfillment: card },
        { worker: { onOrder: () => ({ delivered: { access_code: "SESAME" } }) } },
      );
      script();
      const offer = await priced(itemId);
      const charges = await watching("agentify_payment_settle_duration_seconds", { outcome, mode });
      const release = running().facilitator.holdSettle();
      releases.push(release);

      const paying = paid(itemId, offer, "0x01");
      await vi.waitFor(() => expect(running().facilitator.settles).toHaveLength(1));
      running().advance(4_000);
      release();
      await paying;

      await vi.waitFor(async () => expect((await charges()).times).toBe(1));
      expect((await charges()).seconds).toBeCloseTo(4, 6);
    },
  );

  it("times a read of the payer's wallet, and counts one that failed", async () => {
    const itemId = await started();
    chainAnswering(async () => {
      running().advance(500);
      return PLENTY;
    });
    const reads = await watching("agentify_payer_read_duration_seconds", { outcome: "read" });
    await paid(itemId, await priced(itemId), "0x01");
    const timed = await reads();
    expect(timed.times).toBe(1);
    expect(timed.seconds).toBeCloseTo(0.5, 6);

    // Past the few seconds a balance that covers the price is trusted for.
    running().advance(5_000);
    chainAnswering(() => Promise.reject(new Error("the endpoint is down")));
    const failed = await watching("agentify_payer_read_duration_seconds", { outcome: "failed" });
    await paid(itemId, await priced(itemId), "0x02");
    expect((await failed()).times).toBe(1);
  });
});

describe("a gate's refusals", () => {
  it.each([
    { gate: "proven", chain: true },
    { gate: "unproven", chain: false },
  ] as const)(
    "counts a payment the $gate lane turned away, and the wait the buyer is told",
    async ({ gate, chain }) => {
      const itemId = await started();
      if (chain) chainAnswering(async () => PLENTY);
      const offers = [await priced(itemId), await priced(itemId), await priced(itemId)];
      const refusals = await watching("agentify_gate_refusals_total", { gate });
      const retries = await watching("agentify_retry_after_answers_total", {
        answer: "seller_busy",
        retry_after_seconds: "2",
      });
      releases.push(running().facilitator.holdVerification());

      const [first, second, third] = offers;
      if (first === undefined || second === undefined || third === undefined)
        throw new Error("three prices were not named");
      void paid(itemId, first, "0x01");
      await vi.waitFor(() => expect(running().facilitator.verifies).toHaveLength(1));
      // One wallet holds one place and one place in line, so of the next two one
      // waits behind its own first payment and the other is turned away at once.
      const turnedAway = await Promise.race([
        paid(itemId, second, "0x02"),
        paid(itemId, third, "0x03"),
      ]);

      expect(turnedAway.status).toBe(429);
      expect(turnedAway.headers.get("retry-after")).toBe("2");
      expect((await refusals()).times).toBe(1);
      expect((await retries()).times).toBe(1);
    },
  );

  it("counts a request for a price whose payment is being checked, and the wait it is told", async () => {
    const itemId = await started();
    const offer = await priced(itemId);
    const retries = await watching("agentify_retry_after_answers_total", {
      answer: "payment_being_checked",
      retry_after_seconds: "2",
    });
    releases.push(running().facilitator.holdVerification());

    void paid(itemId, offer, "0x01");
    await vi.waitFor(() => expect(running().facilitator.verifies).toHaveLength(1));
    const again = await paid(itemId, offer, "0x01");

    expect(again.status).toBe(409);
    expect(again.headers.get("retry-after")).toBe("2");
    expect((await retries()).times).toBe(1);
  });

  it("counts a read of a payer's wallet turned away because the merchant's reads are full", async () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const reads = new PayerReads(
      () => ({
        balance: async () => 5n,
        payerState: async () => {
          await opened;
          return { held: 5n, used: false };
        },
      }),
      () => 0,
    );
    const asked = (wallet: number) =>
      reads.stateOf("mch_a", "0xtoken", `0xwallet${wallet}`, "0x01", 1n);
    // Two read at once and eight wait in line; the eleventh is turned away.
    const reading = Array.from({ length: 10 }, (_, one) => asked(one));
    const refusals = await watching("agentify_gate_refusals_total", { gate: "payer_read" });

    expect(await asked(10)).toBeNull();
    expect((await refusals()).times).toBe(1);
    open();
    await Promise.all(reading);
  });
});

describe("what the metrics name", () => {
  it("labels purchase metrics by kind and outcome only, never by merchant, buyer, product, order or price", async () => {
    const itemId = await started(
      { fulfillment: "sync", price_check: "handler" },
      {
        worker: {
          onQuote: () => namedPrice(),
          onOrder: () => ({ delivered: { access_code: "SESAME" } }),
        },
      },
    );
    chainAnswering(async () => PLENTY);
    const offer = await priced(itemId);
    expect((await paid(itemId, offer, "0x01")).status).toBe(200);
    const [order] = await running().store.orders(running().merchant.id);
    if (order === undefined) throw new Error("the purchase made no order");

    const labelled: Record<string, string[]> = {
      agentify_price_answer_duration_seconds: ["integration", "outcome"],
      agentify_price_to_payment_seconds: [],
      agentify_payment_verify_duration_seconds: ["lane", "outcome"],
      agentify_payment_admission_duration_seconds: ["result"],
      agentify_payment_settle_duration_seconds: ["mode", "outcome"],
      agentify_payer_read_duration_seconds: ["outcome"],
      agentify_gate_refusals_total: ["gate"],
      agentify_retry_after_answers_total: ["answer", "retry_after_seconds"],
    };
    const metrics = await telemetry.registry.getMetricsAsJSON();
    for (const [name, labels] of Object.entries(labelled)) {
      const metric = metrics.find((one) => one.name === name);
      expect(metric, name).toBeDefined();
      for (const value of metric?.values ?? []) {
        const { le: _bucket, ...named } = value.labels;
        expect(Object.keys(named).sort(), name).toStrictEqual(labels);
      }
    }
    // A price is a number, and so is every sample, so it is looked for among
    // the labels; an identifier cannot be mistaken for a number anywhere.
    const named = metrics.flatMap((metric) =>
      metric.values.flatMap((value) => Object.values(value.labels).map(String)),
    );
    for (const amount of ["75.00", "75", offer.amount]) {
      expect(named, amount).not.toContain(amount);
    }
    const exported = await telemetry.metrics();
    for (const secret of [
      running().merchant.id,
      running().merchant.wallet,
      itemId,
      order.order.id,
      order.priceId ?? "no price id",
      BUYER.address,
      BUYER.address.toLowerCase(),
      offer.payTo,
    ]) {
      expect(exported, secret).not.toContain(secret);
    }
  });
});
