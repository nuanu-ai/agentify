import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PaymentRecoveryContext, RecoveryFailure } from "../ports/facilitator.js";
import { admitVerifiedOrder } from "../testing/accepted-order.js";
import { drawEverything, type Harness, harness, signedFor } from "../testing/harness.js";
import { aWallet } from "../testing/signed-payment.js";
import { Gateway } from "./gateway.js";

const PAYER_WALLET = aWallet("the payer");
const PAYER = PAYER_WALLET.address.toLowerCase();
const TRANSACTION = `0x${"a".repeat(64)}`;
const card: Card = {
  merchant_item_id: "esim-7d",
  title: "Seven days of data",
  description: "Seven days of mobile data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
};

let open: Harness | null = null;
afterEach(async () => {
  await open?.stop();
  open = null;
  vi.restoreAllMocks();
});

/** Everything the gateway wrote to its log while `run` ran, one call per line. */
async function logged(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const keep = (...words: unknown[]) => {
    lines.push(words.map(String).join(" "));
  };
  for (const level of ["log", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation(keep);
  await run();
  vi.restoreAllMocks();
  return lines;
}

async function purchase(
  fulfillment: "async" | "sync" = "async",
  fulfillDeadlineSeconds?: number,
  settleBeforeGoodsMs?: number,
) {
  const h = await harness({
    SETTLE_RESPONSE_MS: "5000",
    ...(settleBeforeGoodsMs === undefined
      ? {}
      : { SETTLE_BEFORE_GOODS_MS: String(settleBeforeGoodsMs) }),
  });
  open = h;
  const published = await h.gateway.publishCard(h.merchant.id, {
    ...card,
    fulfillment,
    ...(fulfillDeadlineSeconds === undefined
      ? {}
      : { fulfill_deadline_seconds: fulfillDeadlineSeconds }),
  });
  if (!published.ok) throw new Error("the card was refused");
  const merchant = await h.store.merchantById(h.merchant.id);
  const payTo = merchant?.payoutWallet.split?.address;
  if (payTo === undefined) throw new Error("the merchant has no split");
  const recovery: PaymentRecoveryContext = {
    kind: "evm-exact-eip3009",
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payer: PAYER,
    payTo,
    amount: "12000000",
    validAfter: "0",
    validBefore: String(Math.floor(h.now() / 1000) + 600),
    nonce: `0x${"1".repeat(64)}`,
    notBefore: String(Math.floor(h.now() / 1000) - 30),
  };
  h.facilitator.willVerify({ verified: true, payer: PAYER, validUntil: null, recovery });
  const offered = await h.gateway.beginPurchase(published.id, {});
  if (offered.step !== "pay") throw new Error("no price was offered");
  return {
    h,
    recovery,
    orderId: offered.order.order.id,
    stamp: offered.order.priceOffer.stamp,
    priced: offered.order,
  };
}

/** A verified renewal queues on the real row lock before another request is verified. */
async function renewalDuringRefusedVerification(settled: boolean) {
  const scenario = await purchase("sync");
  const { h, recovery, orderId, stamp, priced } = scenario;
  await admitVerifiedOrder(h.gateway, priced, {
    owner: PAYER,
    payment: "PAYMENT",
    fingerprint: "fp-original",
    recovery,
  });
  h.facilitator.willSettle({ settled: false, reason: "the original payment failed" });
  await h.gateway.runner.apply(
    orderId,
    { kind: "handler_delivered", at: h.now() },
    { delivery: { activation_code: "PRIVATE" } },
  );
  expect((await h.store.orderById(orderId))?.order.state).toBe("delivered_unpaid");

  let releaseOrder = () => {};
  let entered = () => {};
  const enteredOrder = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const orderGate = new Promise<void>((resolve) => {
    releaseOrder = resolve;
  });
  const held = h.store.withOrder(orderId, async () => {
    entered();
    await orderGate;
    return { result: undefined };
  });
  await enteredOrder;
  h.facilitator.willVerify({
    verified: true,
    payer: PAYER,
    validUntil: null,
    recovery: { ...recovery, nonce: `0x${"2".repeat(64)}` },
  });
  h.facilitator.willSettle(
    settled
      ? { settled: true, transaction: TRANSACTION }
      : { settled: "unknown", reason: "the renewal response was lost" },
  );
  const accepting = h.gateway.payPurchase(stamp, "RENEWED-PAYMENT", "fp-renewed");
  let releaseVerification = () => {};
  let checking: ReturnType<Gateway["payPurchase"]> | null = null;
  try {
    // A nonce claim proves the renewal passed verification and released its
    // admission permit; its accepted mutation is still waiting on the row.
    await vi.waitFor(async () => {
      expect((await h.store.paymentClaimHolder("fp-renewed"))?.orderId).toBe(orderId);
    });
    releaseVerification = h.facilitator.holdVerification();
    h.facilitator.willRefuseVerification("signature", "the presented signature is invalid");
    checking = h.gateway.payPurchase(stamp, "FORGED-SIGNATURE", "fp-forged");
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(2));
    releaseOrder();
    await accepting;
    releaseVerification();
    return { ...scenario, refused: await checking };
  } finally {
    releaseOrder();
    releaseVerification();
    await Promise.all([held, accepting, checking]);
  }
}

const recoveryDiagnostics = (lines: readonly string[]) =>
  lines.flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed.event === "payment_recovery_pending" ? [parsed] : [];
    } catch {
      return [];
    }
  });

describe("recovering a payment without another charge", () => {
  it("keeps unpaid held goods private after closure and never charges a repeat", async () => {
    const { h, recovery, orderId, stamp, priced } = await purchase("sync");
    await admitVerifiedOrder(h.gateway, priced, {
      owner: PAYER,
      payment: "PAYMENT",
      fingerprint: "fp-original",
      recovery,
    });
    h.facilitator.willSettle({ settled: false, reason: "payment failed" });
    await h.gateway.runner.apply(
      orderId,
      { kind: "handler_delivered", at: h.now() },
      { delivery: { activation_code: "KEPT" } },
    );
    const before = await h.store.orderById(orderId);
    expect(before?.order.state).toBe("delivered_unpaid");
    expect(await h.gateway.closeOrder(h.merchant.id, orderId, {})).toEqual({ ok: true });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    const closed = await h.store.orderById(orderId);
    expect(closed?.order).toMatchObject({ state: "fulfillment_closed", payment: "settle_failed" });
    expect(closed?.delivery).toEqual({ activation_code: "KEPT" });
    expect(closed?.paymentAttempt).toEqual(before?.paymentAttempt);
    expect(await h.store.receipts(h.merchant.id)).toEqual([]);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it.each([true, false])(
    "keeps an original in-flight payment after merchant closure (settled=%s)",
    async (settled) => {
      const { h, recovery, orderId, stamp } = await purchase();
      h.facilitator.willSettle(
        settled
          ? { settled: true, transaction: TRANSACTION }
          : { settled: false, reason: "original payment failed" },
      );
      const release = h.facilitator.holdSettle();
      const buying = h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
      try {
        await vi.waitFor(() => expect(h.facilitator.settles).toHaveLength(1));
        const before = await h.store.orderById(orderId);
        expect(
          await h.gateway.closeOrder(h.merchant.id, orderId, { message: "We agreed an offset." }),
        ).toEqual({ ok: true });
        const closed = await h.store.orderById(orderId);
        expect(closed?.order).toMatchObject({ state: "fulfillment_closed", payment: "settling" });
        expect(closed?.paymentAttempt).toEqual(before?.paymentAttempt);
        expect(closed?.payment).toBe("PAYMENT");
        expect(closed?.buyerKey).toBe(before?.buyerKey);
        expect(closed?.paymentRecovery).toEqual(recovery);
        release();
        await buying;
        const after = await h.store.orderById(orderId);
        expect(after?.order).toMatchObject({
          state: "fulfillment_closed",
          payment: settled ? "settled" : "settle_failed",
        });
        expect(after?.paymentAttempt?.completion?.settled).toBe(settled);
        expect((await h.gateway.poll(h.merchant.id, 0)).envelopes).toMatchObject(
          settled ? [{ payload: { type: "order.unfulfilled", reason: "paid_after_closure" } }] : [],
        );
        expect(await h.store.receipts(h.merchant.id)).toEqual([]);
        expect((await h.store.claimPayment("fp-original", "ord_other")).claimed).toBe(false);
        await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
        expect(h.facilitator.settles).toHaveLength(1);
      } finally {
        release();
        await buying;
      }
    },
  );

  it("recovers an unknown original charge after merchant closure without fulfilling or charging again", async () => {
    const { h, orderId, stamp } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    h.advance(h.runtime.config.deadlines.settleBeforeGoodsMs);
    const timed = await h.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      deadline: "settle_response",
      at: h.now(),
    });
    expect(timed.outcome, JSON.stringify(timed)).toBe("moved");
    expect((await h.store.orderById(orderId))?.order.payment).toBe("outcome_unknown");
    expect(await h.gateway.closeOrder(h.merchant.id, orderId, {})).toEqual({ ok: true });
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now() - 1000,
    });
    await h.gateway.runner.reconcilePayments();
    const closed = await h.store.orderById(orderId);
    expect(closed?.order).toMatchObject({ state: "fulfillment_closed", payment: "settled" });
    expect(closed?.paymentAttempt?.completion).toMatchObject({ settled: true, source: "chain" });
    expect((await h.gateway.poll(h.merchant.id, 0)).envelopes).toMatchObject([
      { payload: { type: "order.unfulfilled", reason: "paid_after_closure" } },
    ]);
    expect(await h.store.receipts(h.merchant.id)).toEqual([]);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("makes no recovery reads while an ordinary settle call is still inside its response window", async () => {
    const { h, orderId, stamp } = await purchase();
    const release = h.facilitator.holdSettle();
    const buying = h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    try {
      await vi.waitFor(() => expect(h.facilitator.settles).toHaveLength(1));
      let recoveryReads = 0;
      h.runtime.facilitator.reconcile = async () => {
        recoveryReads += 1;
        return { settled: "unknown", reason: "the original call is still in flight" };
      };
      await h.gateway.runner.reconcilePayments();
      expect(recoveryReads).toBe(0);
      expect((await h.store.orderById(orderId))?.order.payment).toBe("settling");
    } finally {
      release();
      await buying;
    }
  });

  it("requires a fresh payment signed by its payer to retrieve goods after the original authorization was consumed", async () => {
    const { h, recovery, orderId, stamp, priced } = await purchase();
    const original = await signedFor(h, priced, PAYER_WALLET, {
      nonce: recovery.nonce,
      payTo: recovery.payTo,
    });
    await h.gateway.payPurchase(stamp, original.payment, original.fingerprint);
    await h.gateway.deliverOrder(h.merchant.id, orderId, { activation_code: "BOUGHT" });
    h.facilitator.willRefuseVerification("signature", "the authorization was consumed");
    const retried = await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    expect(retried.step).toBe("payment_not_verified");
    expect(JSON.stringify(retried)).not.toContain("nothing was charged");
    expect(JSON.stringify(retried)).not.toContain(orderId);
    expect(JSON.stringify(retried)).not.toContain("BOUGHT");
    const paid = await h.store.orderById(orderId);
    if (paid === null) throw new Error("the order is gone");
    const replayed = await h.gateway.payPurchase(stamp, original.payment, original.fingerprint);
    expect(replayed.step).toBe("payment_not_verified");
    expect(replayed).not.toHaveProperty("delivery");
    const forged = await h.gateway.payPurchase(stamp, "FORGED-SIGNATURE", "fp-original");
    expect(forged.step).toBe("payment_not_verified");
    expect(forged).not.toHaveProperty("delivery");
    expect(h.facilitator.verifies).toHaveLength(1);
    const renewed = await signedFor(h, paid, PAYER_WALLET, { nonce: "0x02" });
    const fresh = await h.gateway.payPurchase(stamp, renewed.payment, renewed.fingerprint);
    expect(fresh.step).toBe("settled");
    if (fresh.step !== "settled") throw new Error("the verified buyer lost its purchase");
    expect(fresh.delivery).toEqual({ activation_code: "BOUGHT" });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it.each([
    { label: "another signature", elapsed: 6000, presented: "FORGED-SIGNATURE" },
    { label: "an expired original authorization", elapsed: 700000, presented: "PAYMENT" },
  ])("keeps an unresolved payment private for $label", async ({ elapsed, presented }) => {
    const { h, recovery, orderId, stamp, priced } = await purchase("sync");
    await admitVerifiedOrder(h.gateway, priced, {
      owner: PAYER,
      payment: "PAYMENT",
      fingerprint: "fp-original",
      recovery,
    });
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.runner.apply(
      orderId,
      { kind: "handler_delivered", at: h.now() },
      { delivery: { activation_code: "KEPT" } },
    );
    h.advance(elapsed);
    await h.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      deadline: "settle_response",
      at: h.now(),
    });
    const forged = await h.gateway.payPurchase(stamp, presented, "fp-original");
    expect(forged.step).toBe("payment_not_taken");
    if (forged.step !== "payment_not_taken") throw new Error("unknown payment accepted another");
    expect(forged.why).toMatch(/earlier payment.*not known.*no second/i);
    expect(forged.retryable).toBe(true);
    expect(JSON.stringify(forged)).not.toContain(orderId);
    expect(JSON.stringify(forged)).not.toContain("KEPT");
    expect(h.facilitator.settles).toHaveLength(1);
    expect(forged).not.toHaveProperty("delivery");
    expect(h.facilitator.verifies).toHaveLength(0);
    expect((await h.store.orderById(orderId))?.payment).toBe("PAYMENT");
  });

  it("does not claim nonpayment when a verified renewal is accepted during a refused verification", async () => {
    const { h, orderId, refused } = await renewalDuringRefusedVerification(false);
    expect(refused.step).toBe("payment_not_taken");
    if (refused.step !== "payment_not_taken") throw new Error("a second payment was accepted");
    expect(refused.why).toMatch(/earlier payment.*not known.*no second/i);
    expect(refused.retryable).toBe(true);
    expect((await h.store.orderById(orderId))?.payment).toBe("RENEWED-PAYMENT");
    expect((await h.store.orderById(orderId))?.paidBy).toBe(PAYER);
    expect(refused).not.toHaveProperty("delivery");
    expect(JSON.stringify(refused)).not.toContain(orderId);
    expect(JSON.stringify(refused)).not.toContain("PRIVATE");
    expect(h.facilitator.settles).toHaveLength(2);
  });

  it("does not deny a charge completed while a refused payment was being verified", async () => {
    const { h, orderId, refused } = await renewalDuringRefusedVerification(true);
    expect(refused.step).toBe("payment_not_verified");
    if (refused.step !== "payment_not_verified")
      throw new Error("unverified payment read a purchase");
    expect(refused.why).toMatch(/this (?:request|call).*(?:charg.*nothing|no.*charge)/i);
    expect(refused.why).toMatch(/already paid.*fresh payment.*without a second charge/i);
    expect((await h.store.orderById(orderId))?.order.payment).toBe("settled");
    expect((await h.store.orderById(orderId))?.payment).toBe("RENEWED-PAYMENT");
    expect(JSON.stringify(refused)).not.toContain(orderId);
    expect(JSON.stringify(refused)).not.toContain("PRIVATE");
    expect(h.facilitator.settles).toHaveLength(2);
  });

  it("marks a payment found after its fulfillment window unfulfilled, without a handover", async () => {
    // The wait for the charge outlasts the minute, so the payment is still being
    // settled when its window ends.
    const { h, orderId, stamp } = await purchase("async", 60, 90_000);
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    const executedAt = h.now();
    h.advance(61_000);
    const attempt = (await h.store.orderById(orderId))?.paymentAttempt;
    if (attempt === undefined) throw new Error("no submitted attempt");
    await h.gateway.runner.completePaymentAttempt(
      orderId,
      attempt.id,
      {
        settled: true,
        transaction: TRANSACTION,
        executedAt,
      },
      "chain",
    );
    expect((await h.store.orderById(orderId))?.order.state).toBe("unfulfilled");
    expect(
      (await h.store.receipts(h.merchant.id)).find((receipt) => receipt.order_id === orderId) ??
        null,
    ).toBeNull();
    const envelopes = await drawEverything(h, h.merchant.id);
    expect(envelopes.map((envelope) => envelope.kind)).toEqual(["order_event"]);
    expect(envelopes[0]).toMatchObject({
      payload: { type: "order.unfulfilled", at: new Date(executedAt + 60_000).toISOString() },
    });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("keeps scan progress when an older unknown response arrives later", async () => {
    const { h, orderId, stamp } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    const attempt = (await h.store.orderById(orderId))?.paymentAttempt;
    if (attempt === undefined) throw new Error("no submitted attempt");
    await Promise.all([
      h.gateway.runner.completePaymentAttempt(
        orderId,
        attempt.id,
        { settled: "unknown", reason: "new scan", nextBlock: "200" },
        "chain",
      ),
      h.gateway.runner.completePaymentAttempt(
        orderId,
        attempt.id,
        { settled: "unknown", reason: "old scan", nextBlock: "150" },
        "chain",
      ),
    ]);
    expect((await h.store.orderById(orderId))?.paymentAttempt?.nextBlock).toBe("200");
    expect((await h.store.orderById(orderId))?.paymentAttempt?.completion).toBeNull();
  });

  it("ignores a previous attempt's result after a proven failure and a fresh authorization", async () => {
    const { h, recovery, orderId, priced } = await purchase("sync");
    await admitVerifiedOrder(h.gateway, priced, {
      owner: PAYER,
      payment: "PAYMENT",
      fingerprint: "fp-original",
      recovery,
    });
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.runner.apply(
      orderId,
      { kind: "handler_delivered", at: h.now() },
      { delivery: { activation_code: "KEPT" } },
    );
    const first = (await h.store.orderById(orderId))?.paymentAttempt;
    if (first === undefined) throw new Error("no submitted attempt");
    await h.gateway.runner.completePaymentAttempt(
      orderId,
      first.id,
      { settled: false, reason: "expired unused authorization" },
      "chain",
    );
    await h.store.claimPayment("fp-next", orderId);
    const release = h.facilitator.holdSettle();
    const repeating = h.gateway.runner.presentVerifiedPayment(
      orderId,
      PAYER,
      "NEW-PAYMENT",
      recovery.payTo,
      h.now(),
      {
        fingerprint: "fp-next",
        recovery: { ...recovery, nonce: `0x${"2".repeat(64)}` },
      },
    );
    await vi.waitFor(() => expect(h.facilitator.settles).toHaveLength(2));
    const current = (await h.store.orderById(orderId))?.paymentAttempt;
    await h.gateway.runner.completePaymentAttempt(
      orderId,
      first.id,
      { settled: true, transaction: TRANSACTION, executedAt: h.now() },
      "chain",
    );
    expect((await h.store.orderById(orderId))?.order.payment).toBe("settling");
    expect(
      (await h.store.receipts(h.merchant.id)).find((receipt) => receipt.order_id === orderId) ??
        null,
    ).toBeNull();
    release();
    await repeating;
    if (current === undefined) throw new Error("no fresh attempt");
    await h.gateway.runner.completePaymentAttempt(
      orderId,
      current.id,
      { settled: true, transaction: TRANSACTION, executedAt: h.now() },
      "chain",
    );
    expect((await h.store.orderById(orderId))?.order.state).toBe("delivered");
    expect(h.facilitator.settles).toHaveLength(2);
  });

  it("retries a failed atomic receipt write without losing the proof or charging again", async () => {
    const { h, recovery, orderId, priced } = await purchase("sync");
    await admitVerifiedOrder(h.gateway, priced, {
      owner: PAYER,
      payment: "PAYMENT",
      fingerprint: "fp-original",
      recovery,
    });
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.runner.apply(
      orderId,
      { kind: "handler_delivered", at: h.now() },
      { delivery: { activation_code: "KEPT" } },
    );
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now(),
    });
    h.advance(60_000);
    const putReceipt = h.store.putReceipt.bind(h.store);
    h.store.putReceipt = async () => {
      throw new Error("receipt write interrupted");
    };
    await h.gateway.runner.reconcilePayments();
    expect((await h.store.orderById(orderId))?.order.state).toBe("fulfilled");
    expect((await h.store.orderById(orderId))?.paymentAttempt?.completion).toBeNull();
    h.store.putReceipt = putReceipt;
    await h.gateway.runner.reconcilePayments();
    expect((await h.store.orderById(orderId))?.order.state).toBe("delivered");
    expect(
      (await h.store.receipts(h.merchant.id)).find((receipt) => receipt.order_id === orderId) ??
        null,
    ).not.toBeNull();
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("keeps an immutable attempt before the network call, and commits only one racing success", async () => {
    const { h, recovery, orderId, stamp } = await purchase();
    const release = h.facilitator.holdSettle();
    const buying = h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    await vi.waitFor(() => expect(h.facilitator.settles).toHaveLength(1));
    const before = await h.store.orderById(orderId);
    expect(before?.paymentAttempt).toMatchObject({ recovery, completion: null });
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now(),
    });
    h.advance(60_000);
    await h.gateway.runner.reconcilePayments();
    release();
    await buying;
    await h.gateway.runner.reconcilePayments();
    expect((await h.store.orderById(orderId))?.order.state).toBe("unfulfilled");
    expect(await drawEverything(h, h.merchant.id)).toHaveLength(1);
    expect(h.facilitator.settles).toHaveLength(1);
    expect((await h.store.orderById(orderId))?.settlement).toBeNull();
  });

  it("after a restart, marks a charge found on a timed-out order unfulfilled, without asking the merchant for goods", async () => {
    const { h, orderId, stamp } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    h.advance(60_000);
    await h.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      deadline: "settle_response",
      at: h.now(),
    });
    expect(await h.store.openOrders()).toHaveLength(0);
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now() - 59_000,
    });
    const restarted = new Gateway(h.runtime);
    await restarted.runner.reconcilePayments();
    await restarted.runner.reconcilePayments();
    expect((await h.store.orderById(orderId))?.order.state).toBe("unfulfilled");
    const envelopes = await drawEverything(h, h.merchant.id);
    expect(envelopes.map((each) => each.kind)).toEqual(["order_event"]);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("recovers an overdue pending charge after restart even when its reminder has not fired", async () => {
    const { h, orderId, stamp } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    h.advance(60_000);
    expect((await h.store.orderById(orderId))?.order.payment).toBe("settling");
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now() - 59_000,
    });
    const restarted = new Gateway(h.runtime);
    await restarted.runner.reconcilePayments();
    expect((await h.store.orderById(orderId))?.order.state).toBe("unfulfilled");
    expect((await drawEverything(h, h.merchant.id)).every((each) => each.kind !== "order")).toBe(
      true,
    );
  });

  it("releases goods already made, with the observed payment time on the receipt", async () => {
    const { h, recovery, orderId, priced } = await purchase("sync");
    await admitVerifiedOrder(h.gateway, priced, {
      owner: PAYER,
      payment: "PAYMENT",
      fingerprint: "fp-original",
      recovery,
    });
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.runner.apply(
      orderId,
      { kind: "handler_delivered", at: h.now() },
      {
        delivery: { activation_code: "KEPT-GOODS" },
      },
    );
    h.advance(60_000);
    const executedAt = h.now() - 58_000;
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt,
    });
    await h.gateway.runner.reconcilePayments();
    const recovered = await h.store.orderById(orderId);
    expect(recovered?.order.state).toBe("delivered");
    expect(recovered?.delivery).toEqual({ activation_code: "KEPT-GOODS" });
    expect(recovered?.settlement).toBeNull();
    expect(
      (await h.store.receipts(h.merchant.id)).find((receipt) => receipt.order_id === orderId) ??
        null,
    ).toMatchObject({
      transaction: TRANSACTION,
      paid_at: new Date(executedAt).toISOString(),
    });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("retains unknown outcomes and persists scan progress without treating it as a failed payment", async () => {
    const { h, orderId, stamp } = await purchase();
    h.facilitator.willSettle({
      settled: "unknown",
      reason: "response lost",
      transaction: TRANSACTION,
    });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    h.runtime.facilitator.reconcile = async (request) => {
      expect(request.transaction).toBe(TRANSACTION);
      return { settled: "unknown", reason: "more finalized blocks to inspect", nextBlock: "150" };
    };
    h.advance(60_000);
    await h.gateway.runner.reconcilePayments();
    expect((await h.store.orderById(orderId))?.paymentAttempt).toMatchObject({
      nextBlock: "150",
      completion: null,
    });
    expect((await h.store.orderById(orderId))?.order.payment).not.toBe("settle_failed");
    expect(
      (await h.store.receipts(h.merchant.id)).find((receipt) => receipt.order_id === orderId) ??
        null,
    ).toBeNull();
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("keeps the facilitator's own words however many polls find nothing new", async () => {
    const { h, orderId, stamp } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "FACILITATOR-SAID-TIMEOUT" });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    let block = 100;
    h.runtime.facilitator.reconcile = async () => {
      block += 1;
      return { settled: "unknown", reason: "still reading", nextBlock: String(block) };
    };
    h.advance(60_000);
    await logged(async () => {
      for (let poll = 0; poll < 30; poll += 1) await h.gateway.runner.reconcilePayments();
    });
    const saved = await h.store.orderById(orderId);
    expect(saved?.paymentAttempt?.nextBlock).toBe("130");
    const said = saved?.paymentWords.map((word) => word.said) ?? [];
    expect(said).toContain("FACILITATOR-SAID-TIMEOUT");
    expect(said.filter((word) => word === "still reading")).toHaveLength(1);
  });

  it("tells the operator on every poll why recovery cannot read the chain and how long the oldest payment has waited", async () => {
    const { h, orderId, stamp } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    h.runtime.facilitator.reconcile = async () => {
      throw new RecoveryFailure("eth_getBlockByNumber at rpc.example failed: HTTP 429.");
    };
    h.advance(21 * 60_000);
    for (let poll = 0; poll < 2; poll += 1) {
      const lines = await logged(() => h.gateway.runner.reconcilePayments());
      expect(lines.join("\n")).toContain("eth_getBlockByNumber at rpc.example failed: HTTP 429.");
      expect(recoveryDiagnostics(lines)).toMatchObject([
        { value: 1, duration_ms: 21 * 60000, status: "enabled" },
      ]);
    }
    expect((await h.store.orderById(orderId))?.order.payment).toBe("settling");
  });

  it("keeps the place a rate-limited poll reached and still names the failure to the operator", async () => {
    const { h, orderId, stamp } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    h.runtime.facilitator.reconcile = async () => ({
      settled: "unknown",
      reason: "still reading",
      nextBlock: "120",
      failure: "eth_getBlockReceipts at rpc.example failed: HTTP 429.",
    });
    h.advance(60_000);
    const lines = await logged(() => h.gateway.runner.reconcilePayments());
    expect(lines.join("\n")).toContain("eth_getBlockReceipts at rpc.example failed: HTTP 429.");
    expect((await h.store.orderById(orderId))?.paymentAttempt?.nextBlock).toBe("120");
  });

  it("tells the operator on every poll that a payment is unresolved while recovery is off, why, and what turns it on", async () => {
    const { h, stamp } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    h.advance(5 * 60_000);
    const lines = await logged(() => h.gateway.runner.reconcilePayments());
    expect(recoveryDiagnostics(lines)).toMatchObject([
      { value: 1, duration_ms: 5 * 60000, status: "disabled", destination: "PAYMENT_RPC_URL" },
    ]);
  });

  it("says nothing while no payment is unresolved", async () => {
    const { h } = await purchase();
    h.runtime.facilitator.reconcile = async () => {
      throw new Error("no payment should be searched for");
    };
    expect(await logged(() => h.gateway.runner.reconcilePayments())).toEqual([]);
  });

  it("does not count a payment it resolves in the same poll as unresolved", async () => {
    const { h, orderId, stamp } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(stamp, "PAYMENT", "fp-original");
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now(),
    });
    h.advance(60_000);
    const lines = await logged(() => h.gateway.runner.reconcilePayments());
    expect((await h.store.orderById(orderId))?.order.payment).toBe("settled");
    expect(recoveryDiagnostics(lines)).toEqual([]);
  });
});
