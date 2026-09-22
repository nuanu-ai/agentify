/**
 * Recording a payment fact the call did not return.
 *
 * The promise is a narrow one. An order whose charge went quiet can be
 * finished by a fact somebody read elsewhere, and finishing it does not ask
 * the facilitator again and does not present that fact as the facilitator's
 * own answer. A wrong transaction cannot be taken back, so a command that
 * wrote on a guess — a charge still in flight, an order that was never
 * silent, an empty string — is a command that moved somebody's money on
 * nothing.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { runPaymentReport } from "./payment-report-command.js";
import type { Harness } from "./testing/harness.js";
import { harness, workUntilStopped } from "./testing/harness.js";

const syncCard: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  params: { nights: { type: "integer", required: true } },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
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

let open: Harness | null = null;

afterEach(async () => {
  await open?.stop();
  open = null;
});

const quietSync = async (): Promise<{ harnessed: Harness; orderId: string }> => {
  const harnessed = await harness({
    QUOTE_RESPONSE_MS: "50",
    SYNC_RESPONSE_MS: "200",
    SETTLE_RESPONSE_MS: "100",
    SYNC_BUDGET_MS: "2000",
  });
  open = harnessed;
  const published = await harnessed.gateway.publishCard(harnessed.merchant.id, syncCard);
  if (!published.ok) throw new Error("the card was not published");
  harnessed.facilitator.willSettle({ settled: "unknown", reason: "the facilitator timed out" });
  const offered = await harnessed.gateway.beginPurchase(published.id, { nights: 1 });
  if (offered.step !== "pay") throw new Error("no price was offered");
  const worker = workUntilStopped(harnessed, {
    onOrder: () => ({ delivered: { access_code: "SESAME" } }),
  });
  await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
  await worker.stop();
  return { harnessed, orderId: offered.order.order.id };
};

const report = (harnessed: Harness, ...argv: string[]) => {
  const said: string[] = [];
  const code = runPaymentReport(
    argv,
    {
      read: (orderId) => harnessed.store.orderById(orderId),
      record: (orderId, event, facts) => harnessed.gateway.runner.apply(orderId, event, facts),
      now: () => harnessed.now(),
    },
    (line) => {
      said.push(line);
    },
  );
  return code.then((exit) => ({ exit, text: said.join("\n") }));
};

describe("recording what a silent charge came to", () => {
  it("prints the order and writes nothing when no fact is given", async () => {
    const { harnessed, orderId } = await quietSync();
    const before = harnessed.facilitator.settles.length;

    const printed = await report(harnessed, orderId);

    expect(printed.exit).toBe(0);
    expect(printed.text).toContain(orderId);
    expect(printed.text).toContain("outcome_unknown");
    expect(printed.text).not.toContain("PAYMENT");
    expect((await harnessed.store.orderById(orderId))?.order.payment).toBe("outcome_unknown");
    expect(harnessed.facilitator.settles).toHaveLength(before);
  });

  it("releases the goods the merchant already made when the charge is recorded as settled", async () => {
    const { harnessed, orderId } = await quietSync();
    const before = harnessed.facilitator.settles.length;
    const sentAt = (await harnessed.store.orderById(orderId))?.order.timestamps.settleStartedAt;

    const recorded = await report(harnessed, orderId, "settled", "0xfrom-the-dashboard");

    expect(recorded.exit).toBe(0);
    const after = await harnessed.store.orderById(orderId);
    expect(after?.order.state).toBe("delivered");
    expect(after?.order.payment).toBe("settled");
    expect(after?.delivery).toMatchObject({ access_code: "SESAME" });
    expect(after?.settlement).toBeNull();
    const word = after?.paymentWords.at(-1);
    expect(word?.about).toBe("settle");
    expect(word?.said).toContain("0xfrom-the-dashboard");
    expect(word?.said).toContain("not asked");
    expect(word?.said).not.toContain("went through as");
    const receipt = await harnessed.store.receiptForOrder(orderId);
    expect(receipt?.outcome).toBe("delivered");
    expect(receipt?.paid_at).toBe(
      sentAt === null || sentAt === undefined ? undefined : new Date(sentAt).toISOString(),
    );
    expect(harnessed.facilitator.settles).toHaveLength(before);

    const again = await report(harnessed, orderId, "settled", "0xfrom-the-dashboard");
    expect(again.exit).toBe(0);
    expect(again.text).toContain("already");
    expect(harnessed.facilitator.settles).toHaveLength(before);
  });

  it("refuses to record a fact while the charge may still be in flight", async () => {
    const harnessed = await harness();
    open = harnessed;
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, asyncCard);
    if (!published.ok) throw new Error("the card was not published");
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "timed out" });
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    const before = await harnessed.store.orderById(offered.order.order.id);
    expect(before?.order.payment).toBe("settling");

    const refused = await report(harnessed, offered.order.order.id, "failed", "insufficient_funds");

    expect(refused.exit).not.toBe(0);
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.payment).toBe(
      "settling",
    );
  });

  it("refuses an empty fact and a missing order", async () => {
    const { harnessed, orderId } = await quietSync();

    expect((await report(harnessed, orderId, "settled", "  ")).exit).not.toBe(0);
    expect((await report(harnessed, orderId, "failed")).exit).not.toBe(0);
    expect((await report(harnessed, "ord_missing", "settled", "0x1")).exit).not.toBe(0);
    expect((await harnessed.store.orderById(orderId))?.order.payment).toBe("outcome_unknown");
  });
});
