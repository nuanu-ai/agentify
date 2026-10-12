/**
 * The smoke spends real testnet money, so its verdict on whether the money
 * moved has to be right in both directions: a settled charge reported as a
 * failure sends a person to pay again, and an unknown charge reported as a
 * failure hides that the money may already have gone.
 */

import { ScriptedFacilitator, type StoredOrder } from "@agentify/gateway";
import { AgentOrderStatusSchema } from "@nuanu-ai/agentify-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeBuyer } from "./buyer.js";
import { EUROPE_ESIM } from "./cards.js";
import { type Booted, bootGateway } from "./gateway-harness.js";
import { type MockMerchant, startMerchant } from "./merchant.js";
import { settlementOf } from "./smoke.js";

const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const storedWith = (
  payment: StoredOrder["order"]["payment"],
  transaction: string | null,
): Pick<StoredOrder, "order" | "settlement"> =>
  ({
    order: { payment },
    settlement: transaction === null ? null : { transaction },
  }) as Pick<StoredOrder, "order" | "settlement">;

describe("the smoke's verdict on an asynchronous purchase", () => {
  let booted: Booted;
  let merchant: MockMerchant;

  beforeEach(async () => {
    const facilitator = new ScriptedFacilitator();
    booted = await bootGateway(() => facilitator);
    merchant = startMerchant(booted.baseUrl, booted.merchantKey);
    await merchant.start();
  });

  afterEach(async () => {
    await merchant.stop();
    await booted.stop();
  });

  it("counts the charge as settled from the order when the answer carries no settlement", async () => {
    const published = await merchant.client.catalog.publish(EUROPE_ESIM);
    expect(published.ok).toBe(true);
    const buyer = makeBuyer({ baseUrl: booted.baseUrl, privateKey: TEST_BUYER_KEY, maxUsd: 50 });
    const listing = (await buyer.catalog()).find((card) => card.title === EUROPE_ESIM.title);
    if (listing === undefined) throw new Error("the eSIM is not in the catalog");

    const bought = await buyer.buy(listing.id, { email: "smoke@example.com" });
    expect(bought.settlement).toBeNull();
    const { order_id } = AgentOrderStatusSchema.parse(bought.body);
    const stored = await booted.gateway.runtime.store.orderById(order_id);

    const verdict = settlementOf(bought.settlement, stored);

    expect(verdict).toStrictEqual({
      settled: true,
      transaction: stored?.settlement?.transaction,
      readFrom: "order",
    });
  });
});

describe("the smoke's verdict from what it holds", () => {
  it("takes a successful settlement on the answer as settled", () => {
    const verdict = settlementOf(
      { success: true, transaction: "0xabc", network: "eip155:84532" },
      null,
    );
    expect(verdict).toStrictEqual({ settled: true, transaction: "0xabc", readFrom: "answer" });
  });

  it("does not take a failed settlement on the answer as settled", () => {
    const verdict = settlementOf(
      {
        success: false,
        transaction: "",
        network: "eip155:84532",
        errorReason: "insufficient_funds",
      },
      null,
    );
    expect(verdict.settled).toBe(false);
  });

  it("says the money may have moved when the charge was never answered", () => {
    const verdict = settlementOf(null, storedWith("outcome_unknown", null));
    expect(verdict.settled).toBe(false);
    if (verdict.settled) return;
    expect(verdict.why).toMatch(/may have moved/);
  });

  it("does not count an order whose charge was refused", () => {
    expect(settlementOf(null, storedWith("settle_failed", null)).settled).toBe(false);
  });

  it("does not count an order that reads settled without a transaction to check", () => {
    expect(settlementOf(null, storedWith("settled", null)).settled).toBe(false);
  });

  it("does not count a purchase the gateway holds no order for", () => {
    expect(settlementOf(null, null).settled).toBe(false);
  });
});
