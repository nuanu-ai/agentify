/**
 * The transaction that paid an order, told to its buyer and named to its
 * merchant once the payment is known to have gone through, whether or not the
 * goods have reached the buyer. Before that, and on a payment that did not go
 * through or whose outcome is unknown, there is no transaction to tell.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettleOutcome } from "../ports/facilitator.js";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  statusPathOf,
} from "../testing/harness.js";
import { PAYMENT_RESPONSE_HEADER } from "./x402.js";

const TRANSACTION = `0x${"a".repeat(64)}`;

const asyncCard: Card = {
  merchant_item_id: "esim-7-days",
  title: "A seven day eSIM",
  description: "Seven days of data, activated by code",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
};

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness(overrides);
  const served = await serve(harnessed);
  open = { harnessed, served };
  const published = await harnessed.gateway.publishCard(harnessed.merchant.id, asyncCard);
  if (!published.ok) throw new Error("the card would not publish");
  return { harnessed, served, itemId: published.id };
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

/** The order as its buyer reads it. */
const buyerStatus = async (served: Served, orderId: string) =>
  (await served.call("GET", await statusPathOf(open?.harnessed ?? noGateway(), orderId)))
    .body as Record<string, unknown>;

/**
 * The order as its merchant reads it, alone and in their list, and their
 * receipts, all with their key.
 */
const merchantReads = async (served: Served, orderId: string) => {
  const headers = { authorization: `Bearer ${open?.harnessed.merchant.key ?? noGateway()}` };
  const alone = await served.call("GET", `/v0/orders/${orderId}`, { headers });
  const listed = await served.call("GET", "/v0/orders", { headers });
  const receipts = await served.call("GET", "/v0/receipts", { headers });
  return {
    alone: alone.body as Record<string, unknown>,
    listed: (listed.body as { orders: Record<string, unknown>[] }).orders.find(
      (one) => one.id === orderId,
    ),
    receipts: (receipts.body as { receipts: unknown[] }).receipts,
  };
};

const noGateway = (): never => {
  throw new Error("no gateway is running");
};

/** The transaction the standard payment response header names, or null where there is none. */
const transactionInHeader = (answer: { headers: Headers }): string | null => {
  const header = answer.headers.get(PAYMENT_RESPONSE_HEADER);
  return header === null ? null : decodePaymentResponseHeader(header).transaction;
};

describe("the transaction that paid an order", () => {
  it("is told to the buyer, in the purchase's answer and its status, while the goods are still to come", async () => {
    const { harnessed, served, itemId } = await started();
    harnessed.facilitator.willSettle({ settled: true, transaction: TRANSACTION });

    const bought = await buyOverHttp(harnessed, served, itemId, {});

    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ status: "in_progress", payment_status: "paid" });
    expect(transactionInHeader(bought)).toBe(TRANSACTION);
    const orderId = (bought.body as { order_id: string }).order_id;
    expect(await buyerStatus(served, orderId)).toMatchObject({
      payment_status: "paid",
      transaction: TRANSACTION,
    });
  });

  it("is named on the merchant's order, read alone and listed, while the goods are still to come and there is no receipt", async () => {
    const { harnessed, served, itemId } = await started();
    harnessed.facilitator.willSettle({ settled: true, transaction: TRANSACTION });

    const bought = await buyOverHttp(harnessed, served, itemId, {});

    const orderId = (bought.body as { order_id: string }).order_id;
    const merchant = await merchantReads(served, orderId);
    for (const document of [merchant.alone, merchant.listed]) {
      expect(document).toMatchObject({
        status: "in_progress",
        payment_status: "paid",
        transaction: TRANSACTION,
      });
    }
    expect(merchant.receipts).toStrictEqual([]);
  });

  it("is named on the merchant's order charged after its goods, once that charge went through", async () => {
    const { harnessed, served } = await started();
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      ...asyncCard,
      merchant_item_id: "esim-now",
      fulfillment: "sync",
    });
    if (!published.ok) throw new Error("the card would not publish");
    harnessed.facilitator.willSettle({ settled: true, transaction: TRANSACTION });

    const bought = await buyOverHttp(harnessed, served, published.id, {
      onOrder: () => ({ delivered: { activation_code: "LPA:1$example.com$NOW" } }),
    });

    expect(bought.body).toMatchObject({ status: "delivered", payment_status: "paid" });
    const orderId = (bought.body as { order_id: string }).order_id;
    const merchant = await merchantReads(served, orderId);
    for (const document of [merchant.alone, merchant.listed]) {
      expect(document).toMatchObject({ payment_status: "paid", transaction: TRANSACTION });
    }
  });

  it("is told to nobody while the charge has not come back, and to the buyer and the merchant once it has", async () => {
    const { harnessed, served, itemId } = await started();
    harnessed.facilitator.willSettle({ settled: true, transaction: TRANSACTION });
    const release = harnessed.facilitator.holdSettle();
    let buying: ReturnType<typeof buyOverHttp> | undefined;
    try {
      buying = buyOverHttp(harnessed, served, itemId, {});
      await vi.waitFor(() => expect(harnessed.facilitator.settles).toHaveLength(1));
      const [held] = await harnessed.store.orders(harnessed.merchant.id);
      const orderId = held?.order.id ?? "";

      const waiting = await buyerStatus(served, orderId);
      expect(waiting.payment_status).not.toBe("paid");
      expect(waiting).not.toHaveProperty("transaction");
      const merchantWaiting = await merchantReads(served, orderId);
      for (const document of [merchantWaiting.alone, merchantWaiting.listed]) {
        expect(document?.payment_status).not.toBe("paid");
        expect(document).not.toHaveProperty("transaction");
      }

      release();
      const bought = await buying;
      expect(transactionInHeader(bought)).toBe(TRANSACTION);
      expect((await buyerStatus(served, orderId)).transaction).toBe(TRANSACTION);
      expect((await merchantReads(served, orderId)).alone.transaction).toBe(TRANSACTION);
    } finally {
      release();
      await buying;
    }
  });

  it.each([
    ["did not go through", { settled: false, reason: "refused in the script" }, "not_paid"],
    [
      "went unanswered, though the payment layer named a transaction",
      { settled: "unknown", reason: "timed out", transaction: TRANSACTION },
      "unresolved",
    ],
  ] as const)(
    "is told to neither the buyer nor the merchant for a charge that %s",
    async (_case, outcome: SettleOutcome, paymentStatus) => {
      const { harnessed, served, itemId } = await started();
      harnessed.facilitator.willSettle(outcome);

      const bought = await buyOverHttp(harnessed, served, itemId, {});

      expect(transactionInHeader(bought)).toBeNull();
      const orderId = (bought.body as { order_id: string }).order_id;
      const read = await buyerStatus(served, orderId);
      const merchant = await merchantReads(served, orderId);
      const documents = [bought.body as Record<string, unknown>, read, merchant.alone];
      if (merchant.listed !== undefined) documents.push(merchant.listed);
      for (const document of documents) {
        expect(document.payment_status).toBe(paymentStatus);
        expect(document).not.toHaveProperty("transaction");
      }
      expect(JSON.stringify(documents)).not.toContain(TRANSACTION);
    },
  );

  it("is the one the chain showed, to the buyer and the merchant, for a payment found there after its charge went unanswered", async () => {
    const { harnessed, served, itemId } = await started({ SETTLE_RESPONSE_MS: "5000" });
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "response lost" });
    const bought = await buyOverHttp(harnessed, served, itemId, {});
    const orderId = (bought.body as { order_id: string }).order_id;
    const attempt = (await harnessed.store.orderById(orderId))?.paymentAttempt;
    if (attempt === undefined) throw new Error("no charge was sent");

    await harnessed.gateway.runner.completePaymentAttempt(
      orderId,
      attempt.id,
      { settled: true, transaction: TRANSACTION, executedAt: harnessed.now() },
      "chain",
    );

    expect(await buyerStatus(served, orderId)).toMatchObject({
      payment_status: "paid",
      transaction: TRANSACTION,
    });
    expect((await merchantReads(served, orderId)).alone).toMatchObject({
      payment_status: "paid",
      transaction: TRANSACTION,
    });
  });
});
