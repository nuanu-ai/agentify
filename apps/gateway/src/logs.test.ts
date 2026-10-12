/**
 * What the gateway's log says when something fails. The operator reads it to
 * act, and it is kept wherever logs go, further than anything the gateway
 * erases: so a line names what failed and the identifiers needed to find it,
 * and nothing the failure carried. Each failure here carries a shop's secret
 * and a newline that would start a forged line, as a driver's or a client's
 * failure can, and neither may reach the log.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SWEEP_EFFECTS } from "./app/runner.js";
import {
  type Harness,
  harness,
  loggedWhile,
  type Served,
  serve,
  workOnce,
} from "./testing/harness.js";

const SECRET = "cs_a-secret-from-the-shop";
const FORGED = "\n[gateway] forged";
const carrying = (): Error => new Error(`${SECRET}${FORGED}`);

const expectNothingCarried = (written: string): void => {
  expect(written).not.toContain(SECRET);
  expect(written).not.toContain("forged");
};

const asyncCard: Card = {
  merchant_item_id: "esim-7d",
  title: "A seven day eSIM",
  description: "Seven days of data",
  price: { amount: "12.00", currency: "USD" },
  result: { activation_code: { type: "string" } },
  fulfillment: "async",
  fulfill_deadline_seconds: 3_600,
};

/** What makes a harness live, the one deployment that announces a wallet change. */
const LIVE = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
};

let open: Harness | null = null;
let served: Served | null = null;

const started = async (overrides: Record<string, string> = {}): Promise<Harness> => {
  open = await harness(overrides);
  return open;
};

afterEach(async () => {
  await served?.close();
  served = null;
  await open?.stop();
  open = null;
});

/** An order priced and waiting for its payment. */
const quoted = async (harnessed: Harness): Promise<string> => {
  const published = await harnessed.gateway.publishCard(harnessed.merchant.id, asyncCard);
  if (!published.ok) throw new Error("the card would not publish");
  const offered = await harnessed.gateway.beginPurchase(published.id, {});
  if (offered.step !== "pay") throw new Error("no price was offered");
  return offered.order.order.id;
};

/** An order paid for and waiting on the merchant's stream. */
const paid = async (harnessed: Harness): Promise<string> => {
  const orderId = await quoted(harnessed);
  await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");
  const state = (await harnessed.store.orderById(orderId))?.order.state;
  if (state !== "paid") throw new Error(`the order is ${state}, not paid`);
  return orderId;
};

const sweep = async (harnessed: Harness): Promise<void> => {
  const work = harnessed.queue.daily.get(SWEEP_EFFECTS);
  if (work === undefined) throw new Error("the gateway registered no sweep of effects");
  await work();
};

describe("a failure in the gateway's log", () => {
  it("names the reminder and its order when a reminder fails", async () => {
    const harnessed = await started();
    harnessed.store.withOrder = async () => {
      throw carrying();
    };

    const written = await loggedWhile(async () => {
      await harnessed.queue.remind(
        { kind: "deadline", deadline: "quote_expiry", at: harnessed.now(), orderId: "ord_9" },
        0,
      );
      await vi.waitFor(() => {
        expect(vi.mocked(console.error)).toHaveBeenCalled();
      });
    });

    expect(written).toContain("a reminder failed (deadline, order ord_9)");
    expectNothingCarried(written);
  });

  it("names the change when telling a merchant about it fails", async () => {
    const harnessed = await started(LIVE);
    harnessed.announcer.answer = async () => {
      throw carrying();
    };

    const written = await loggedWhile(() =>
      harnessed.gateway.setPayoutWallet(
        harnessed.merchant.id,
        "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
        { kind: "signed_in", email: "owner@example.com" },
      ),
    );

    expect(written).toContain("an announcement (wallet_change) failed");
    expectNothingCarried(written);
  });

  it("names the order and why a payment was refused, and none of the payment layer's words", async () => {
    // The layer's words can quote the payment presented, and a mismatch is
    // described with what the payer's own client put in it.
    const harnessed = await started();
    const orderId = await quoted(harnessed);
    harnessed.facilitator.willRefuseVerification("insufficient_funds", `${SECRET}${FORGED}`);

    const written = await loggedWhile(() =>
      harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT"),
    );

    expect(written).toContain(`a payment for ${orderId} did not verify`);
    expect(written).toContain("insufficient_funds");
    expectNothingCarried(written);
  });

  it("names the order whose charge went unanswered, and keeps the layer's words on the order alone", async () => {
    // The operator who later records what became of the charge reads the
    // words off the order.
    const harnessed = await started();
    const orderId = await quoted(harnessed);
    harnessed.facilitator.willSettle({ settled: "unknown", reason: `${SECRET}${FORGED}` });

    const written = await loggedWhile(() =>
      harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT"),
    );

    expect(written).toContain(orderId);
    expectNothingCarried(written);
    const kept = (await harnessed.store.orderById(orderId))?.paymentWords ?? [];
    expect(kept.map((word) => word.said)).toContain(`${SECRET}${FORGED}`);
  });

  it("names the order whose hand-over could not be recorded", async () => {
    const harnessed = await started();
    const orderId = await paid(harnessed);
    harnessed.store.withOrder = async () => {
      throw carrying();
    };

    const written = await loggedWhile(() => harnessed.gateway.poll(harnessed.merchant.id, 0));

    expect(written).toContain(`could not record the hand-over of ${orderId}`);
    expectNothingCarried(written);
  });

  it("names the key whose last use could not be written down", async () => {
    const harnessed = await started();
    harnessed.store.noteKeyUse = async () => {
      throw carrying();
    };

    const written = await loggedWhile(() => harnessed.gateway.keyBehind(harnessed.merchant.key));

    expect(written).toContain(`the last use of the key ${harnessed.merchant.keyId}`);
    expectNothingCarried(written);
  });

  it("names the order the sweep could not repair", async () => {
    const harnessed = await started();
    const orderId = await paid(harnessed);
    harnessed.advance(harnessed.runtime.config.sweepDispatchGraceMs + 1);
    harnessed.queue.holdsOrder = async () => {
      throw carrying();
    };

    const written = await loggedWhile(() => sweep(harnessed));

    expect(written).toContain(`the sweep could not repair ${orderId}`);
    expectNothingCarried(written);
  });

  it("names the order the sweep could not write a receipt for", async () => {
    const harnessed = await started();
    const orderId = await paid(harnessed);
    await workOnce(harnessed, { onOrder: () => ({ delivered: { activation_code: "CODE" } }) }, 0);
    const delivered = await harnessed.store.orderById(orderId);
    if (delivered === null) throw new Error("the order is gone");
    harnessed.store.deliveredWithoutReceipt = async () => [delivered];
    harnessed.store.putReceipt = async () => {
      throw carrying();
    };

    const written = await loggedWhile(() => sweep(harnessed));

    expect(written).toContain(`the sweep could not receipt ${orderId}`);
    expectNothingCarried(written);
  });

  it("names the call that failed, and answers it as the gateway's failure", async () => {
    const harnessed = await started();
    served = await serve(harnessed);
    harnessed.store.cards = async () => {
      throw carrying();
    };

    let status = 0;
    const written = await loggedWhile(async () => {
      status =
        (
          await served?.call("GET", "/v0/cards", {
            headers: { authorization: `Bearer ${harnessed.merchant.key}` },
          })
        )?.status ?? 0;
    });

    expect(status).toBe(500);
    expect(written).toContain("list_merchant_cards failed");
    expectNothingCarried(written);
  });
});
