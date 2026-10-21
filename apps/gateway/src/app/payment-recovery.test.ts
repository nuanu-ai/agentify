import type { Card } from "@nuanu-ai/agentify-contracts";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizationFingerprint } from "../http/x402.js";
import { type PaymentRecoveryContext, RecoveryFailure } from "../ports/facilitator.js";
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

async function purchase(fulfillment: "async" | "sync" = "async", fulfillDeadlineSeconds?: number) {
  const h = await harness({ SETTLE_RESPONSE_MS: "5000" });
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
  return { h, recovery, orderId: offered.order.order.id };
}

describe("recovering a payment without another charge", () => {
  it("keeps unpaid held goods private after closure and never charges a repeat", async () => {
    const { h, recovery, orderId } = await purchase("sync");
    await h.store.claimPayment("fp-original", orderId);
    await h.gateway.runner.presentVerifiedPayment(
      orderId,
      PAYER,
      "PAYMENT",
      recovery.payTo,
      h.now(),
      { recovery, fingerprint: "fp-original" },
    );
    h.facilitator.willSettle({ settled: false, reason: "payment failed" });
    await h.gateway.runner.apply(
      orderId,
      { kind: "handler_delivered", at: h.now() },
      { delivery: { activation_code: "KEPT" } },
    );
    const before = await h.store.orderById(orderId);
    expect(before?.order.state).toBe("delivered_unpaid");
    expect(await h.gateway.closeOrder(h.merchant.id, orderId, {})).toEqual({ ok: true });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
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
      const { h, recovery, orderId } = await purchase();
      h.facilitator.willSettle(
        settled
          ? { settled: true, transaction: TRANSACTION }
          : { settled: false, reason: "original payment failed" },
      );
      const release = h.facilitator.holdSettle();
      const buying = h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
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
        expect(closed?.paymentRef).toBe(before?.paymentRef);
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
        await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
        expect(h.facilitator.settles).toHaveLength(1);
      } finally {
        release();
        await buying;
      }
    },
  );

  it("recovers an unknown original charge after merchant closure without fulfilling or charging again", async () => {
    const { h, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    h.advance(20_000);
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
    const { h, orderId } = await purchase();
    const release = h.facilitator.holdSettle();
    const buying = h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
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

  it("refuses an expired original authorization without disclosing held goods or denying a possible charge", async () => {
    const { h, recovery, orderId } = await purchase("sync");
    await h.store.claimPayment("fp-original", orderId);
    await h.gateway.runner.presentVerifiedPayment(
      orderId,
      PAYER,
      "PAYMENT",
      recovery.payTo,
      h.now(),
      { recovery, fingerprint: "fp-original" },
    );
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.runner.apply(
      orderId,
      { kind: "handler_delivered", at: h.now() },
      { delivery: { activation_code: "KEPT" } },
    );
    h.advance(700_000);
    await h.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      deadline: "settle_response",
      at: h.now(),
    });
    h.facilitator.willRefuseVerification("price_stale", "the authorization expired");
    const retried = await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    expect(retried.step).toBe("payment_not_taken");
    expect(JSON.stringify(retried)).not.toContain("nothing was charged");
    expect(JSON.stringify(retried)).not.toContain(orderId);
    expect(JSON.stringify(retried)).not.toContain("KEPT");
    expect(h.facilitator.verifies).toHaveLength(0);
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("requires a fresh payment signed by its payer to retrieve goods after the original authorization was consumed", async () => {
    const { h, recovery, orderId } = await purchase();
    const quoted = await h.store.orderById(orderId);
    if (quoted === null) throw new Error("the order is gone");
    const original = await signedFor(h, quoted, PAYER_WALLET, {
      nonce: recovery.nonce,
      payTo: recovery.payTo,
    });
    await h.gateway.payPurchase(orderId, original.payment, original.fingerprint);
    await h.gateway.deliverOrder(h.merchant.id, orderId, { activation_code: "BOUGHT" });
    h.facilitator.willRefuseVerification("signature", "the authorization was consumed");
    const retried = await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    expect(retried.step).toBe("payment_not_verified");
    expect(JSON.stringify(retried)).not.toContain("nothing was charged");
    expect(JSON.stringify(retried)).not.toContain(orderId);
    expect(JSON.stringify(retried)).not.toContain("BOUGHT");
    const paid = await h.store.orderById(orderId);
    if (paid === null) throw new Error("the order is gone");
    const replayed = await h.gateway.payPurchase(orderId, original.payment, original.fingerprint);
    expect(replayed.step).toBe("payment_not_verified");
    expect(replayed).not.toHaveProperty("delivery");
    const forged = await h.gateway.payPurchase(orderId, "FORGED-SIGNATURE", "fp-original");
    expect(forged.step).toBe("payment_not_verified");
    expect(forged).not.toHaveProperty("delivery");
    expect(h.facilitator.verifies).toHaveLength(1);
    const renewed = await signedFor(h, paid, PAYER_WALLET, { nonce: "0x02" });
    const fresh = await h.gateway.payPurchase(orderId, renewed.payment, renewed.fingerprint);
    expect(fresh.step).toBe("settled");
    if (fresh.step !== "settled") throw new Error("the verified buyer lost its purchase");
    expect(fresh.delivery).toEqual({ activation_code: "BOUGHT" });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("refuses a different payment while the original outcome is unknown without claiming nothing was charged", async () => {
    const { h, recovery, orderId } = await purchase("sync");
    await h.store.claimPayment("fp-original", orderId);
    await h.gateway.runner.presentVerifiedPayment(
      orderId,
      PAYER,
      "PAYMENT",
      recovery.payTo,
      h.now(),
      { recovery, fingerprint: "fp-original" },
    );
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.runner.apply(
      orderId,
      { kind: "handler_delivered", at: h.now() },
      { delivery: { activation_code: "KEPT" } },
    );
    await h.gateway.runner.apply(orderId, {
      kind: "deadline_expired",
      deadline: "settle_response",
      at: h.now() + 6000,
    });
    h.facilitator.willRefuseVerification("signature", "forged signature on the public nonce");
    const forged = await h.gateway.payPurchase(orderId, "FORGED-SIGNATURE", "fp-original");
    expect(forged.step).toBe("payment_not_taken");
    expect(JSON.stringify(forged)).not.toContain("nothing was charged");
    expect(forged).not.toHaveProperty("delivery");
    expect(h.facilitator.verifies).toHaveLength(0);
    expect((await h.store.orderById(orderId))?.payment).toBe("PAYMENT");
  });

  it("does not claim nonpayment when another request accepted the order during verification", async () => {
    const { h, recovery, orderId } = await purchase();
    const release = h.facilitator.holdVerification();
    h.facilitator.willRefuseVerification("signature", "the presented signature is invalid");
    const checking = h.gateway.payPurchase(orderId, "FORGED-SIGNATURE", "fp-original");
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(1));
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.store.claimPayment("fp-accepted", orderId);
    await h.gateway.runner.presentVerifiedPayment(
      orderId,
      PAYER,
      "PAYMENT",
      recovery.payTo,
      h.now(),
      { recovery, fingerprint: "fp-accepted" },
    );
    release();
    const refused = await checking;
    expect(refused.step).toBe("payment_not_taken");
    expect(JSON.stringify(refused)).not.toContain("nothing was charged");
    expect(refused).not.toHaveProperty("delivery");
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("does not deny a charge completed while a refused payment was being verified", async () => {
    const { h, recovery, orderId } = await purchase();
    const release = h.facilitator.holdVerification();
    h.facilitator.willRefuseVerification("signature", "the presented signature is invalid");
    const checking = h.gateway.payPurchase(orderId, "PUBLIC-USED-PAYMENT", "fp-original");
    await vi.waitFor(() => expect(h.facilitator.verifies).toHaveLength(1));
    await h.store.claimPayment("fp-accepted", orderId);
    await h.gateway.runner.presentVerifiedPayment(
      orderId,
      PAYER,
      "PAYMENT",
      recovery.payTo,
      h.now(),
      { recovery, fingerprint: "fp-accepted" },
    );
    await h.gateway.deliverOrder(h.merchant.id, orderId, { activation_code: "PRIVATE" });
    release();

    const refused = await checking;

    expect(refused.step).toBe("payment_not_verified");
    expect(JSON.stringify(refused)).not.toContain("nothing was charged");
    expect(JSON.stringify(refused)).not.toContain(orderId);
    expect(JSON.stringify(refused)).not.toContain("PRIVATE");
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("marks a payment found after its fulfillment window unfulfilled, without a handover", async () => {
    const { h, orderId } = await purchase("async", 1);
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    const executedAt = h.now();
    h.advance(2_000);
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
    expect(await h.store.receiptForOrder(orderId)).toBeNull();
    const envelopes = await drawEverything(h, h.merchant.id);
    expect(envelopes.map((envelope) => envelope.kind)).toEqual(["order_event"]);
    expect(envelopes[0]).toMatchObject({
      payload: { type: "order.unfulfilled", at: new Date(executedAt + 1000).toISOString() },
    });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("keeps scan progress when an older unknown response arrives later", async () => {
    const { h, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
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
    const { h, recovery, orderId } = await purchase("sync");
    await h.store.claimPayment("fp-original", orderId);
    await h.gateway.runner.presentVerifiedPayment(
      orderId,
      PAYER,
      "PAYMENT",
      recovery.payTo,
      h.now(),
      { recovery, fingerprint: "fp-original" },
    );
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
    expect(await h.store.receiptForOrder(orderId)).toBeNull();
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
    const { h, recovery, orderId } = await purchase("sync");
    await h.store.claimPayment("fp-original", orderId);
    await h.gateway.runner.presentVerifiedPayment(
      orderId,
      PAYER,
      "PAYMENT",
      recovery.payTo,
      h.now(),
      { recovery, fingerprint: "fp-original" },
    );
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
    expect(await h.store.receiptForOrder(orderId)).not.toBeNull();
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("reconstructs an old unanswered attempt from its saved terms and retains its authorization", async () => {
    const { h, recovery, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    await h.store.withOrder(orderId, (found) => {
      const {
        paymentAttempt: _attempt,
        paymentRecovery: _recovery,
        paymentFingerprint: _fingerprint,
        ...saved
      } = found;
      return { save: saved, result: null };
    });
    // The search may start no later than the order's creation: the payment
    // was checked after the order existed, and anything later could skip it.
    const created = (await h.store.orderById(orderId))?.order.timestamps.createdAt;
    let searchedSince: number | undefined;
    h.runtime.facilitator.recoveryFor = async (charge, since) => {
      expect(charge).toMatchObject({ payment: "PAYMENT", payTo: recovery.payTo, amount: "12.00" });
      searchedSince = since;
      return recovery;
    };
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now(),
    });
    h.advance(60_000);
    await h.gateway.runner.reconcilePayments();
    expect(searchedSince).toBe(created);
    expect((await h.store.orderById(orderId))?.order.state).toBe("unfulfilled");
    await h.store.forgetClaimsBefore(h.now() + 100_000);
    expect(await h.store.claimPayment(authorizationFingerprint(recovery), "another-order")).toEqual(
      { claimed: false, heldBy: orderId },
    );
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("does not search the chain for an old payment whose signer is not the order's buyer", async () => {
    const { h, recovery, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    await h.store.withOrder(orderId, (found) => {
      const {
        paymentAttempt: _attempt,
        paymentRecovery: _recovery,
        paymentFingerprint: _fingerprint,
        ...saved
      } = found;
      return { save: saved, result: null };
    });
    const stranger = { ...recovery, payer: "0x00000000000000000000000000000000000000ff" };
    h.runtime.facilitator.recoveryFor = async () => stranger;
    let searched = 0;
    h.runtime.facilitator.reconcile = async () => {
      searched += 1;
      return { settled: true, transaction: TRANSACTION, executedAt: h.now() };
    };
    h.advance(60_000);
    await h.gateway.runner.reconcilePayments();
    expect(searched).toBe(0);
    expect((await h.store.orderById(orderId))?.order.payment).toBe("settling");
    expect(
      (await h.store.claimPayment(authorizationFingerprint(stranger), "another-order")).claimed,
    ).toBe(true);
  });

  it("leaves a legacy authorization assigned to two saved purchases unknown", async () => {
    const { h, recovery, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    const payment = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        asset: recovery.asset,
        payTo: recovery.payTo,
        amount: recovery.amount,
        maxTimeoutSeconds: 600,
        extra: {},
      },
      payload: {
        authorization: { from: recovery.payer, nonce: recovery.nonce },
        signature: "0xsigned",
      },
    });
    await h.store.withOrder(orderId, (found) => {
      const {
        paymentAttempt: _attempt,
        paymentRecovery: _recovery,
        paymentFingerprint: _fingerprint,
        ...saved
      } = found;
      return { save: { ...saved, payment }, result: null };
    });
    const saved = await h.store.orderById(orderId);
    if (saved === null) throw new Error("no saved order");
    await h.store.addOrder({
      ...saved,
      paymentRef: "pay_duplicate",
      order: { ...saved.order, id: "ord_duplicate" },
    });
    h.runtime.facilitator.recoveryFor = async () => recovery;
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now(),
    });
    h.advance(60_000);
    await h.gateway.runner.reconcilePayments();
    expect((await h.store.orderById(orderId))?.order.payment).toBe("settling");
    expect((await h.store.orderById("ord_duplicate"))?.order.payment).toBe("settling");
    expect((await h.store.orderById(orderId))?.paymentAttempt).toBeUndefined();
    expect(await h.store.receiptForOrder(orderId)).toBeNull();
  });

  it("keeps an immutable attempt before the network call, and commits only one racing success", async () => {
    const { h, recovery, orderId } = await purchase();
    const release = h.facilitator.holdSettle();
    const buying = h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
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
    const { h, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
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
    const { h, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
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
    const { h, recovery, orderId } = await purchase("sync");
    await h.store.claimPayment("fp-original", orderId);
    await h.gateway.runner.presentVerifiedPayment(
      orderId,
      PAYER,
      "PAYMENT",
      recovery.payTo,
      h.now(),
      {
        recovery,
        fingerprint: "fp-original",
      },
    );
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
    expect(await h.store.receiptForOrder(orderId)).toMatchObject({
      transaction: TRANSACTION,
      paid_at: new Date(executedAt).toISOString(),
    });
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("retains unknown outcomes and persists scan progress without treating it as a failed payment", async () => {
    const { h, orderId } = await purchase();
    h.facilitator.willSettle({
      settled: "unknown",
      reason: "response lost",
      transaction: TRANSACTION,
    });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
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
    expect(await h.store.receiptForOrder(orderId)).toBeNull();
    expect(h.facilitator.settles).toHaveLength(1);
  });

  it("keeps the facilitator's own words however many polls find nothing new", async () => {
    const { h, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "FACILITATOR-SAID-TIMEOUT" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
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
    const { h, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    h.runtime.facilitator.reconcile = async () => {
      throw new RecoveryFailure("eth_getBlockByNumber at rpc.example failed: HTTP 429.");
    };
    h.advance(21 * 60_000);
    for (let poll = 0; poll < 2; poll += 1) {
      const lines = await logged(() => h.gateway.runner.reconcilePayments());
      expect(lines.join("\n")).toContain("eth_getBlockByNumber at rpc.example failed: HTTP 429.");
      expect(lines.join("\n")).toMatch(/\b1 unresolved payment\b.*\b21 minutes\b/);
    }
    expect((await h.store.orderById(orderId))?.order.payment).toBe("settling");
  });

  it("keeps the place a rate-limited poll reached and still names the failure to the operator", async () => {
    const { h, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
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
    const { h, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    h.advance(5 * 60_000);
    const lines = await logged(() => h.gateway.runner.reconcilePayments());
    expect(lines.join("\n")).toMatch(
      /\b1 unresolved payment\b.*\b5 minutes\b.*recovery is off.*no RPC.*PAYMENT_RPC_URL/,
    );
  });

  it("says nothing while no payment is unresolved", async () => {
    const { h } = await purchase();
    h.runtime.facilitator.reconcile = async () => {
      throw new Error("no payment should be searched for");
    };
    expect(await logged(() => h.gateway.runner.reconcilePayments())).toEqual([]);
  });

  it("does not count a payment it resolves in the same poll as unresolved", async () => {
    const { h, orderId } = await purchase();
    h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    await h.gateway.payPurchase(orderId, "PAYMENT", "fp-original");
    h.runtime.facilitator.reconcile = async () => ({
      settled: true,
      transaction: TRANSACTION,
      executedAt: h.now(),
    });
    h.advance(60_000);
    const lines = await logged(() => h.gateway.runner.reconcilePayments());
    expect((await h.store.orderById(orderId))?.order.payment).toBe("settled");
    expect(lines.join("\n")).not.toMatch(/unresolved payment/);
  });
});
