/**
 * The smoke spends real testnet money, so its verdict on whether the money
 * moved has to be right in every direction: a settled charge reported as a
 * failure sends a person to pay again, a refused payment reported as unknown
 * hides what the gateway said, and an unanswered charge reported as a failure
 * hides that the money may already have gone.
 */

import { ScriptedFacilitator, type StoredOrder } from "@agentify/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeBuyer } from "./buyer.js";
import { EUROPE_ESIM } from "./cards.js";
import { type Booted, bootGateway } from "./gateway-harness.js";
import { type MockMerchant, startMerchant } from "./merchant.js";
import { verdictOnPurchase } from "./smoke.js";

const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("the smoke's verdict on a purchase through the gateway", () => {
  let booted: Booted;
  let facilitator: ScriptedFacilitator;
  let merchant: MockMerchant;

  beforeEach(async () => {
    facilitator = new ScriptedFacilitator();
    booted = await bootGateway(() => facilitator);
    merchant = startMerchant(booted.baseUrl, booted.merchantKey);
    await merchant.start();
    const published = await merchant.client.catalog.publish(EUROPE_ESIM);
    expect(published.ok).toBe(true);
  });

  afterEach(async () => {
    await merchant.stop();
    await booted.stop();
  });

  const buyTheEsim = async () => {
    const buyer = makeBuyer({ baseUrl: booted.baseUrl, privateKey: TEST_BUYER_KEY, maxUsd: 50 });
    const listing = (await buyer.catalog()).find((card) => card.title === EUROPE_ESIM.title);
    if (listing === undefined) throw new Error("the eSIM is not in the catalog");
    const bought = await buyer.buy(listing.id, { email: "smoke@example.com" });
    return verdictOnPurchase(bought, (id) => booted.gateway.runtime.store.orderById(id));
  };

  it("counts an asynchronous charge as settled from the order, though the answer carries no settlement", async () => {
    const verdict = await buyTheEsim();

    // The scripted facilitator names its first settlement 0xtx1; the smoke has
    // to have read it off the order, since the answer carried none.
    expect(verdict).toStrictEqual({ kind: "settled", transaction: "0xtx1", readFrom: "order" });
  });

  it("reports a payment the gateway refused as not charged", async () => {
    facilitator.willRefuseVerification("insufficient_funds");

    const verdict = await buyTheEsim();

    expect(verdict.kind).toBe("not_charged");
    expect(facilitator.settles).toHaveLength(0);
  });
});

const orderReading = (
  ...stages: [StoredOrder["order"]["payment"], string | null][]
): ((id: string) => Promise<StoredOrder | null>) => {
  let read = 0;
  return async () => {
    const [payment, transaction] = stages[Math.min(read, stages.length - 1)] ?? ["none", null];
    read += 1;
    return {
      order: { payment },
      settlement: transaction === null ? null : { transaction },
    } as StoredOrder;
  };
};

const anOrder = { status: 200, body: { order_id: "order-1" }, settlement: null };
const quickly = { timeoutMs: 50, everyMs: 0 };

describe("the smoke's verdict from what it reads", () => {
  it("takes a successful settlement on the answer as settled", async () => {
    const verdict = await verdictOnPurchase(
      { ...anOrder, settlement: { success: true, transaction: "0xabc", network: "eip155:84532" } },
      orderReading(["none", null]),
      quickly,
    );
    expect(verdict).toStrictEqual({ kind: "settled", transaction: "0xabc", readFrom: "answer" });
  });

  it("takes a failed settlement on the answer as not charged", async () => {
    const verdict = await verdictOnPurchase(
      {
        ...anOrder,
        settlement: {
          success: false,
          transaction: "",
          network: "eip155:84532",
          errorReason: "insufficient_funds",
        },
      },
      orderReading(["none", null]),
      quickly,
    );
    expect(verdict.kind).toBe("not_charged");
  });

  it("waits for the charge to be answered before judging", async () => {
    const verdict = await verdictOnPurchase(
      anOrder,
      orderReading(["settling", null], ["settling", null], ["settled", "0xdef"]),
      quickly,
    );
    expect(verdict).toStrictEqual({ kind: "settled", transaction: "0xdef", readFrom: "order" });
  });

  it("calls a charge the payment layer never answered unknown", async () => {
    const verdict = await verdictOnPurchase(
      anOrder,
      orderReading(["settling", null], ["outcome_unknown", null]),
      quickly,
    );
    expect(verdict.kind).toBe("unknown");
  });

  it("calls a charge still running when the wait ends unknown", async () => {
    const verdict = await verdictOnPurchase(anOrder, orderReading(["settling", null]), quickly);
    expect(verdict.kind).toBe("unknown");
  });

  it("takes a charge the payment layer refused as not charged", async () => {
    const verdict = await verdictOnPurchase(
      anOrder,
      orderReading(["settle_failed", null]),
      quickly,
    );
    expect(verdict.kind).toBe("not_charged");
  });

  it("does not count an order that reads settled without a transaction to check", async () => {
    for (const transaction of [null, ""]) {
      const verdict = await verdictOnPurchase(
        anOrder,
        orderReading(["settled", transaction]),
        quickly,
      );
      expect(verdict.kind).toBe("unknown");
    }
  });

  it("calls a refusal by a failing gateway unknown and any other refusal not charged", async () => {
    const refusal = { error: { code: "x", message: "refused", retryable: false } };
    const failing = await verdictOnPurchase(
      { status: 502, body: refusal, settlement: null },
      orderReading(["none", null]),
      quickly,
    );
    const refused = await verdictOnPurchase(
      { status: 409, body: refusal, settlement: null },
      orderReading(["none", null]),
      quickly,
    );
    expect(failing.kind).toBe("unknown");
    expect(refused.kind).toBe("not_charged");
  });
});
