/**
 * Recording a payment fact the call did not return.
 *
 * The promise is a narrow one. An order whose charge went quiet can be
 * finished by a fact somebody read elsewhere, and finishing it does not ask
 * the facilitator again and does not present that fact as the facilitator's
 * own answer. A fact written while the original settle call is still out
 * races that answer, and the one that lands second is dropped. A failure
 * recorded on an open order would allow a second charge on a guess about
 * the first. Neither is written.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "fp_buyer");
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
    // The authorisation itself stays off the terminal. The payer does not:
    // that is who the fact is about.
    expect(printed.text).not.toContain("PAYMENT");
    expect(printed.text).toContain("fp_buyer");
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
    // A receipt would date a proof from a time the payment layer never named.
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
    await harnessed.gateway.runner.sweep();
    expect(await harnessed.store.receiptForOrder(orderId)).toBeNull();
    expect(harnessed.facilitator.settles).toHaveLength(before);
    expect(sentAt).not.toBeUndefined();

    const again = await report(harnessed, orderId, "settled", "0xfrom-the-dashboard");
    expect(again.exit).toBe(0);
    expect(again.text).toContain("already");
    expect(harnessed.facilitator.settles).toHaveLength(before);
  });

  it("turns a late settlement of a closed silence into the debt it is", async () => {
    const harnessed = await harness({ SETTLE_RESPONSE_MS: "100" });
    open = harnessed;
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, asyncCard);
    if (!published.ok) throw new Error("the card was not published");
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "timed out" });
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const before = harnessed.facilitator.settles.length;
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    expect(harnessed.facilitator.settles).toHaveLength(before + 1);
    await harnessed.gateway.runner.apply(offered.order.order.id, {
      kind: "deadline_expired",
      at: harnessed.now() + 60_000,
      deadline: "settle_response",
    });
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.payment).toBe(
      "outcome_unknown",
    );

    const recorded = await report(harnessed, offered.order.order.id, "settled", "0xlate");

    expect(recorded.exit).toBe(0);
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.state).toBe(
      "refund_due",
    );
    expect(harnessed.facilitator.settles).toHaveLength(before + 1);
    const drawn = await harnessed.gateway.poll(harnessed.merchant.id, 10, 0);
    expect(
      drawn.envelopes.flatMap((each) => (each.kind === "order_event" ? [each.payload.type] : [])),
    ).toContain("order.refund_due");
  });

  it("does not record a fact while the original settle call is still out", async () => {
    const harnessed = await harness({
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "50",
      SYNC_BUDGET_MS: "2000",
    });
    open = harnessed;
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, syncCard);
    if (!published.ok) throw new Error("the card was not published");
    const release = harnessed.facilitator.holdSettle();
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "still out" });
    const offered = await harnessed.gateway.beginPurchase(published.id, { nights: 1 });
    if (offered.step !== "pay") throw new Error("no price was offered");
    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const buying = harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "fp_held");
    await vi.waitFor(
      async () => {
        expect((await harnessed.store.orderById(offered.order.order.id))?.order.payment).toBe(
          "outcome_unknown",
        );
      },
      { timeout: 2_000 },
    );
    const held = await harnessed.store.orderById(offered.order.order.id);
    expect(held?.paymentWords.some((word) => word.about === "settle")).toBe(false);

    const refused = await report(harnessed, offered.order.order.id, "settled", "0xguess");

    expect(refused.exit).not.toBe(0);
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.payment).toBe(
      "outcome_unknown",
    );
    release();
    await buying;
    await worker.stop();
    expect(
      (await harnessed.store.orderById(offered.order.order.id))?.paymentWords.some(
        (word) => word.about === "settle",
      ),
    ).toBe(true);
  });

  it("does not record a failure on an open order, which would allow a second charge", async () => {
    const { harnessed, orderId } = await quietSync();
    const before = harnessed.facilitator.settles.length;

    const refused = await report(harnessed, orderId, "failed", "insufficient_funds");

    expect(refused.exit).not.toBe(0);
    expect((await harnessed.store.orderById(orderId))?.order.payment).toBe("outcome_unknown");
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
