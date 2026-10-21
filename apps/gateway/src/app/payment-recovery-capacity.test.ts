import { afterEach, describe, expect, it, vi } from "vitest";
import { EUROPE_ESIM } from "../../../../packages/slice/src/cards.js";
import { RecoveryFailure } from "../ports/facilitator.js";
import type { StoredOrder } from "../ports/store.js";
import { type Harness, harness } from "../testing/harness.js";

const PAYER = "0x0000000000000000000000000000000000000008";
const TRANSACTION = `0x${"a".repeat(64)}`;
let open: Harness | null = null;

afterEach(async () => {
  await open?.stop();
  open = null;
  vi.restoreAllMocks();
});

/** Persist real purchase attempts for two merchants, with every original charge unanswered. */
async function unanswered(count: number) {
  const h = await harness({ SETTLE_RESPONSE_MS: "5000" });
  open = h;
  h.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
  const merchants = [h.merchant, await h.addMerchant("Another shop")];
  const items: string[] = [];
  for (const merchant of merchants) {
    const published = await h.gateway.publishCard(merchant.id, EUROPE_ESIM);
    if (!published.ok) throw new Error("the eSIM was refused");
    items.push(published.id);
  }
  const records: StoredOrder[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = items[index % items.length];
    if (item === undefined) throw new Error("the merchant has no item");
    const offered = await h.gateway.beginPurchase(item, { email: "buyer@example.com" });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const merchant = await h.store.merchantById(offered.order.merchantId);
    const payTo = merchant?.payoutWallet.split?.address;
    if (payTo === undefined) throw new Error("the merchant has no split");
    h.facilitator.willVerify({
      verified: true,
      payer: PAYER,
      validUntil: null,
      recovery: {
        kind: "evm-exact-eip3009",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payer: PAYER,
        payTo,
        amount: "8000000",
        validAfter: "0",
        validBefore: String(Math.floor(h.now() / 1000) + 600),
        nonce: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        notBefore: String(Math.floor(h.now() / 1000) - 30),
      },
    });
    await h.gateway.payPurchase(offered.order.order.id, `PAYMENT-${index}`, `fp-${index}`);
    const saved = await h.store.orderById(offered.order.order.id);
    if (saved === null) throw new Error("the purchase disappeared");
    records.push(saved);
  }
  h.advance(60_000);
  records.sort((one, other) => (one.order.id < other.order.id ? -1 : 1));
  return { h, records };
}

const nonceOf = (record: StoredOrder | undefined): string => {
  const nonce = record?.paymentAttempt?.recovery?.nonce;
  if (nonce === undefined) throw new Error("the purchase has no recovery terms");
  return nonce;
};

describe("payment recovery under a backlog", () => {
  it("recovers a later page while an earlier merchant's payment is still being checked", async () => {
    const { h, records } = await unanswered(102);
    const slow = nonceOf(records[0]);
    const later = records.at(-1);
    if (later === undefined) throw new Error("no later purchase");
    const held = Promise.withResolvers<void>();
    h.runtime.facilitator.reconcile = async ({ context }) => {
      if (context.nonce === slow) await held.promise;
      return { settled: true, transaction: TRANSACTION, executedAt: h.now() - 1_000 };
    };
    const checking = h.gateway.runner.reconcilePayments();
    try {
      await vi.waitFor(async () => {
        expect((await h.store.orderById(later.order.id))?.order.payment).toBe("settled");
      });
      expect((await h.store.orderById(records[0]?.order.id ?? ""))?.order.payment).toBe("settling");
    } finally {
      held.resolve();
      await checking;
    }
    expect(h.facilitator.settles).toHaveLength(records.length);
  });

  it("limits concurrent chain checks and uses a free slot before other checks finish", async () => {
    const { h, records } = await unanswered(7);
    const held = Promise.withResolvers<void>();
    const first = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    let started = 0;
    h.runtime.facilitator.reconcile = async ({ context }) => {
      active += 1;
      peak = Math.max(peak, active);
      started += 1;
      await (context.nonce === nonceOf(records[0]) ? first.promise : held.promise);
      active -= 1;
      return { settled: true, transaction: TRANSACTION, executedAt: h.now() - 1_000 };
    };
    const checking = h.gateway.runner.reconcilePayments();
    try {
      await vi.waitFor(() => expect(started).toBe(4));
      first.resolve();
      await vi.waitFor(() => expect(started).toBe(5));
      expect(peak).toBe(4);
    } finally {
      first.resolve();
      held.resolve();
      await checking;
    }
    expect(peak).toBe(4);
    for (const record of records)
      expect((await h.store.orderById(record.order.id))?.order.payment).toBe("settled");
    expect(h.facilitator.settles).toHaveLength(records.length);
  });

  it("preserves unknown outcomes and search progress while a sibling payment recovers", async () => {
    const { h, records } = await unanswered(3);
    h.runtime.facilitator.reconcile = async ({ context }) => {
      if (context.nonce === nonceOf(records[0]))
        throw new RecoveryFailure("The recovery RPC did not answer.");
      if (context.nonce === nonceOf(records[1]))
        return { settled: "unknown", reason: "still reading", nextBlock: "120" };
      return { settled: true, transaction: TRANSACTION, executedAt: h.now() - 1_000 };
    };
    await h.gateway.runner.reconcilePayments();
    const failed = await h.store.orderById(records[0]?.order.id ?? "");
    const unknown = await h.store.orderById(records[1]?.order.id ?? "");
    expect(failed?.paymentAttempt?.completion).toBeNull();
    expect(unknown?.paymentAttempt).toMatchObject({ completion: null, nextBlock: "120" });
    expect((await h.store.orderById(records[2]?.order.id ?? ""))?.order.payment).toBe("settled");
    for (const [index, record] of records.entries()) {
      expect(
        await h.store.claimPayment(`fp-${Number(BigInt(nonceOf(record))) - 1}`, "another-order"),
      ).toEqual({ claimed: false, heldBy: record.order.id });
      if (index < 2) expect((await h.store.orderById(record.order.id))?.settlement).toBeNull();
    }
    expect(h.facilitator.settles).toHaveLength(records.length);
  });

  it("keeps the sweep lock until started checks finish after a page read fails", async () => {
    const { h, records } = await unanswered(102);
    const held = Promise.withResolvers<void>();
    let started = 0;
    h.runtime.facilitator.reconcile = async ({ context }) => {
      started += 1;
      if (context.nonce === nonceOf(records[0])) await held.promise;
      return { settled: true, transaction: TRANSACTION, executedAt: h.now() - 1_000 };
    };
    const read = h.store.unresolvedPayments.bind(h.store);
    let pageFailed = false;
    h.store.unresolvedPayments = async (after, limit) => {
      if (after !== "") {
        pageFailed = true;
        throw new Error("the next page could not be read");
      }
      return read(after, limit);
    };
    let ended = false;
    const checking = h.gateway.runner
      .reconcilePayments()
      .then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        ended = true;
      });
    try {
      await vi.waitFor(() => expect(pageFailed).toBe(true));
      expect(ended).toBe(false);
      await h.gateway.runner.reconcilePayments();
      expect(started).toBe(100);
      expect((await h.store.orderById(records[0]?.order.id ?? ""))?.order.payment).toBe("settling");
    } finally {
      held.resolve();
      expect((await checking).error).toEqual(new Error("the next page could not be read"));
      h.store.unresolvedPayments = read;
    }
    await h.gateway.runner.reconcilePayments();
    for (const record of records)
      expect((await h.store.orderById(record.order.id))?.order.payment).toBe("settled");
    expect(h.facilitator.settles).toHaveLength(records.length);
  });
});
