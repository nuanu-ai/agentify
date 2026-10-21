/**
 * Which wallets' signatures this gateway can judge by itself when a paid
 * purchase is asked for again. A key's signature is read here; a contract
 * wallet's is the chain's to judge, and where the chain cannot be asked the
 * payment goes to the payment layer as any other payment would.
 */

import { describe, expect, it } from "vitest";
import { PaymentEdge } from "../http/x402.js";
import type { SignatureReader } from "../ports/signatures.js";
import { testConfig } from "../testing/harness.js";
import { aWallet, signedPayment } from "../testing/signed-payment.js";
import { returningPayment } from "./returning-payment.js";

const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const edge = new PaymentEdge(testConfig());
const paid = {
  paymentRef: "pay_1",
  payTo: "0x00000000000000000000000000000000000000f1",
  payment: null,
  price: { amount: "80.00", currency: "USD" },
};
const requirements = edge.requirementsFor(paid.price, paid.paymentRef, paid.payTo);
const WALLET = aWallet("a wallet that is a contract");
/** A signature no key made: what a contract wallet's own scheme can look like. */
const CONTRACTS_SIGNATURE = `0x${"cd".repeat(97)}` as const;

const signed = (signature?: `0x${string}`) =>
  signedPayment(WALLET, requirements, {
    nonce: "0x02",
    validBefore: NOW + 60_000,
    ...(signature === undefined ? {} : { signature }),
  });

/** A chain that answers `verdict` for every signature, and counts what it is asked. */
const aChain = (verdict: boolean | Error) => {
  const asked: string[] = [];
  const reader: SignatureReader = {
    async accepts(wallet) {
      asked.push(wallet);
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
  };
  return { reader, asked };
};

describe("a contract wallet's signature for a paid purchase", () => {
  it("is accepted on the chain's word", async () => {
    const chain = aChain(true);

    const checked = await returningPayment(
      await signed(CONTRACTS_SIGNATURE),
      paid,
      edge,
      NOW,
      chain.reader,
    );

    expect(checked).toMatchObject({ verified: true, payer: WALLET.address });
    expect(chain.asked).toStrictEqual([WALLET.address]);
  });

  it("is refused when the chain refuses it", async () => {
    const checked = await returningPayment(
      await signed(CONTRACTS_SIGNATURE),
      paid,
      edge,
      NOW,
      aChain(false).reader,
    );

    expect(checked).toMatchObject({ verified: false, reason: "signature" });
  });

  it.each([
    ["no chain is configured", undefined],
    ["the chain did not answer", aChain(new Error("the endpoint did not answer")).reader],
  ])("is left to the payment layer where %s", async (_where, reader) => {
    expect(
      await returningPayment(await signed(CONTRACTS_SIGNATURE), paid, edge, NOW, reader),
    ).toBeNull();
  });
});

describe("a key's signature for a paid purchase", () => {
  it("is read here without asking the chain", async () => {
    const chain = aChain(new Error("the chain was asked"));

    const checked = await returningPayment(await signed(), paid, edge, NOW, chain.reader);

    expect(checked).toMatchObject({ verified: true, payer: WALLET.address });
    expect(chain.asked).toStrictEqual([]);
  });
});
