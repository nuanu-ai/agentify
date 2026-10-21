/**
 * Getting back a purchase already paid for. A buyer whose answer was lost
 * signs the payment requirements it kept once more, from the same wallet, and
 * is answered with its order. That payment is never charged, so whether it
 * would have the money behind it has no bearing on the answer, and nothing
 * about it is asked of the payment layer.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, harness, type Served, serve, workUntilStopped } from "../testing/harness.js";
import { aWallet, type SignedTerms, signedPayment } from "../testing/signed-payment.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402.js";

const card: Card = {
  merchant_item_id: "room-101",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

const BUYER = aWallet("the buyer");
const STRANGER = aWallet("somebody else");
const ELSEWHERE = "0x00000000000000000000000000000000000000e1";

let open: { harnessed: Harness; served: Served; stop: () => Promise<void> } | null = null;

afterEach(async () => {
  await open?.stop();
  open = null;
});

/**
 * A sale the buyer paid for and was answered once; what the buyer sends next
 * is up to the test. The buyer's wallet has nothing left in it from then on,
 * as the payment layer would say of any payment it is asked about.
 */
async function aPaidSale() {
  const harnessed = await harness();
  const served = await serve(harnessed);
  const worker = workUntilStopped(harnessed, {
    onOrder: () => ({ delivered: { access_code: "SESAME" } }),
  });
  open = {
    harnessed,
    served,
    stop: async () => {
      await worker.stop();
      await served.close();
      await harnessed.stop();
    },
  };
  const published = await harnessed.gateway.publishCard(harnessed.merchant.id, card);
  if (!published.ok) throw new Error("the card would not publish");
  const purchase = `/x402/${published.id}/purchase`;

  const priced = await served.call("POST", purchase, { body: { params: {} } });
  const requirements = decodePaymentRequiredHeader(
    priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
  ).accepts[0] as PaymentRequirements;
  const fresh = (nonce: string): SignedTerms => ({
    nonce,
    validBefore: harnessed.now() + requirements.maxTimeoutSeconds * 1_000,
  });
  const present = (payment: string) =>
    served.call("POST", purchase, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: payment },
    });

  const paying = await signedPayment(BUYER, requirements, fresh("0x01"));
  const paid = await present(paying);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  const orderId = (paid.body as { order_id: string }).order_id;
  harnessed.facilitator.willRefuseVerification("insufficient_funds", "insufficient_funds");

  return { harnessed, requirements, fresh, present, paying, orderId };
}

/** How many times the payment layer was asked to verify, and to charge. */
const askedOf = (harnessed: Harness) => ({
  verified: harnessed.facilitator.verifies.length,
  charged: harnessed.facilitator.settles.length,
});

const codeOf = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } }).error?.code;

describe("a purchase already paid for", () => {
  it("comes back to its payer's fresh signature with no second charge, though the wallet is empty now", async () => {
    const sale = await aPaidSale();

    const again = await sale.present(
      await signedPayment(BUYER, sale.requirements, sale.fresh("0x02")),
    );

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({
      order_id: sale.orderId,
      delivered: { access_code: "SESAME" },
    });
    expect(askedOf(sale.harnessed)).toStrictEqual({ verified: 1, charged: 1 });
  });

  it("is not another wallet's, however well it signs", async () => {
    const sale = await aPaidSale();

    const theirs = await sale.present(
      await signedPayment(STRANGER, sale.requirements, sale.fresh("0x02")),
    );

    expect(theirs.status).toBe(409);
    expect(codeOf(theirs.body)).toBe("not_this_purchase");
    expect(JSON.stringify(theirs.body)).not.toContain(sale.orderId);
    expect(askedOf(sale.harnessed)).toStrictEqual({ verified: 1, charged: 1 });
  });

  it("is not returned to the payment that paid it, which can be read from the chain", async () => {
    const sale = await aPaidSale();

    const replayed = await sale.present(sale.paying);

    expect(replayed.status).toBe(409);
    expect(codeOf(replayed.body)).toBe("payment_not_verified");
    expect(JSON.stringify(replayed.body)).not.toContain(sale.orderId);
    expect(askedOf(sale.harnessed)).toStrictEqual({ verified: 1, charged: 1 });
  });

  it.each([
    ["another amount", { value: "1" }],
    ["another payee", { payTo: ELSEWHERE }],
    ["another network", { network: "eip155:8453" as const }],
  ])("is not returned to a payment for %s", async (_what, changed) => {
    const sale = await aPaidSale();

    const wrong = await sale.present(
      await signedPayment(BUYER, sale.requirements, { ...sale.fresh("0x02"), ...changed }),
    );

    expect(wrong.status).toBe(409);
    expect(codeOf(wrong.body)).toBe("payment_not_verified");
    expect(JSON.stringify(wrong.body)).not.toContain(sale.orderId);
    expect(askedOf(sale.harnessed)).toStrictEqual({ verified: 1, charged: 1 });
  });

  it.each([
    ["has run out", (now: number) => ({ validBefore: now - 1_000 })],
    ["is not valid yet", (now: number) => ({ validAfter: now + 60_000 })],
  ])("is not returned to an authorization that %s", async (_when, window) => {
    const sale = await aPaidSale();

    const stale = await sale.present(
      await signedPayment(BUYER, sale.requirements, {
        ...sale.fresh("0x02"),
        ...window(sale.harnessed.now()),
      }),
    );

    expect(stale.status).toBe(409);
    expect(codeOf(stale.body)).toBe("payment_not_verified");
    expect(askedOf(sale.harnessed)).toStrictEqual({ verified: 1, charged: 1 });
  });

  it.each([
    ["a signature of nothing at all", `0x${"ab".repeat(65)}` as const],
    ["a signature that is not hex", "0xsigned" as `0x${string}`],
    ["no signature", "0x" as const],
  ])("is not returned to %s, and the payment layer is not asked", async (_what, signature) => {
    const sale = await aPaidSale();

    const forged = await sale.present(
      await signedPayment(BUYER, sale.requirements, { ...sale.fresh("0x02"), signature }),
    );

    expect(forged.status).toBe(409);
    expect(codeOf(forged.body)).toBe("payment_not_verified");
    expect(JSON.stringify(forged.body)).toMatch(/if this purchase was already paid for/);
    expect(askedOf(sale.harnessed)).toStrictEqual({ verified: 1, charged: 1 });
  });

  it("is not returned to another wallet's signature written over the payer's address", async () => {
    const sale = await aPaidSale();
    const theirs = await signedPayment(STRANGER, sale.requirements, sale.fresh("0x02"));
    const { signature } = JSON.parse(Buffer.from(theirs, "base64").toString("utf8")).payload;

    const forged = await sale.present(
      await signedPayment(BUYER, sale.requirements, { ...sale.fresh("0x02"), signature }),
    );

    expect(codeOf(forged.body)).toBe("payment_not_verified");
    expect(askedOf(sale.harnessed)).toStrictEqual({ verified: 1, charged: 1 });
  });
});

describe("a purchase not paid for yet", () => {
  it("is paid only after the payment layer has checked the payment", async () => {
    const harnessed = await harness();
    const served = await serve(harnessed);
    open = {
      harnessed,
      served,
      stop: async () => {
        await served.close();
        await harnessed.stop();
      },
    };
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, card);
    if (!published.ok) throw new Error("the card would not publish");
    const purchase = `/x402/${published.id}/purchase`;
    const priced = await served.call("POST", purchase, { body: { params: {} } });
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0] as PaymentRequirements;
    harnessed.facilitator.willRefuseVerification("insufficient_funds", "insufficient_funds");

    const unfunded = await served.call("POST", purchase, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: await signedPayment(BUYER, requirements, {
          nonce: "0x01",
          validBefore: harnessed.now() + requirements.maxTimeoutSeconds * 1_000,
        }),
      },
    });

    expect(codeOf(unfunded.body)).toBe("payment_not_verified");
    expect(JSON.stringify(unfunded.body)).toMatch(/fund the paying wallet/);
    expect(askedOf(harnessed)).toStrictEqual({ verified: 1, charged: 0 });
  });
});
